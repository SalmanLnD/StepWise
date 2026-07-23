import React, { useMemo } from 'react';
import { useStore, useCurrentStep, usePrevStep } from '../store.jsx';
import { buildHeapMap, isRefVal, intOf, isIndexName, sameVal, fmtVal } from '../utils/format.js';
import VarCards from './viz/VarCards.jsx';
import ArrayView from './viz/ArrayView.jsx';
import DictView from './viz/DictView.jsx';
import ListChainView from './viz/ListChainView.jsx';
import TreeView from './viz/TreeView.jsx';
import GraphView from './viz/GraphView.jsx';
import ObjectsView from './viz/ObjectsView.jsx';

/**
 * Analyse the heap of one step and group objects into renderable structures.
 */
function analyse(step) {
  const heapMap = buildHeapMap(step);
  const consumed = new Set();
  const structures = [];

  const objs = step.heap;
  const byId = heapMap;

  const isTreeNode = (o) =>
    o.kind === 'object' && o.fields.some(([k]) => k === 'left') && o.fields.some(([k]) => k === 'right');
  const isChainNode = (o) => o.kind === 'object' && o.fields.some(([k]) => k === 'next') && !isTreeNode(o);

  /* ---- graphs: map whose values are all refs to arrays ---- */
  for (const o of objs) {
    if (o.kind !== 'map' || o.entries.length < 2) continue;
    const allAdj = o.entries.every(([, v]) => {
      if (!isRefVal(v)) return false;
      const t = byId.get(v.id);
      return t && (t.kind === 'array' || t.kind === 'set');
    });
    if (allAdj) {
      structures.push({ type: 'graph', obj: o });
      consumed.add(o.id);
      for (const [, v] of o.entries) consumed.add(v.id);
    }
  }

  /* ---- trees ---- */
  const treeNodes = objs.filter((o) => isTreeNode(o) && !consumed.has(o.id));
  if (treeNodes.length) {
    const referenced = new Set();
    for (const o of treeNodes) {
      for (const [k, v] of o.fields) {
        if ((k === 'left' || k === 'right') && isRefVal(v)) referenced.add(v.id);
      }
    }
    for (const root of treeNodes) {
      if (referenced.has(root.id)) continue;
      structures.push({ type: 'tree', obj: root });
    }
    for (const o of treeNodes) consumed.add(o.id);
  }

  /* ---- linked chains ---- */
  const chainNodes = objs.filter((o) => isChainNode(o) && !consumed.has(o.id));
  if (chainNodes.length) {
    const ids = new Set(chainNodes.map((o) => o.id));
    const incoming = new Set();
    for (const o of chainNodes) {
      for (const [k, v] of o.fields) {
        if (isRefVal(v) && ids.has(v.id) && k !== 'prev') incoming.add(v.id);
      }
    }
    const heads = chainNodes.filter((o) => !incoming.has(o.id));
    const seen = new Set();
    const chains = [];
    const collect = (start) => {
      const chain = [];
      let cur = start;
      let guard = 0;
      while (cur && !seen.has(cur.id) && guard++ < 60) {
        seen.add(cur.id);
        chain.push(cur);
        const nxt = cur.fields.find(([k]) => k === 'next')?.[1];
        cur = nxt && isRefVal(nxt) ? byId.get(nxt.id) : null;
      }
      return chain;
    };
    for (const h of heads) chains.push(collect(h));
    for (const o of chainNodes) {
      if (!seen.has(o.id)) chains.push(collect(o)); // cycles / orphans
    }
    if (chains.length) {
      structures.push({ type: 'chains', chains, all: chainNodes });
      for (const o of chainNodes) consumed.add(o.id);
    }
  }

  /* ---- matrices: arrays whose items are all refs to arrays ---- */
  for (const o of objs) {
    if (consumed.has(o.id) || o.kind !== 'array' || o.items.length === 0) continue;
    const allRows = o.items.every((v) => {
      if (!isRefVal(v)) return false;
      const t = byId.get(v.id);
      return t && t.kind === 'array';
    });
    if (allRows) {
      structures.push({ type: 'matrix', obj: o });
      consumed.add(o.id);
      for (const v of o.items) consumed.add(v.id);
    }
  }

  /* ---- plain arrays / sets ---- */
  for (const o of objs) {
    if (consumed.has(o.id)) continue;
    if (o.kind === 'array' || o.kind === 'set') {
      structures.push({ type: 'array', obj: o });
      consumed.add(o.id);
    }
  }

  /* ---- maps ---- */
  for (const o of objs) {
    if (consumed.has(o.id)) continue;
    if (o.kind === 'map') {
      structures.push({ type: 'dict', obj: o });
      consumed.add(o.id);
    }
  }

  /* ---- remaining objects ---- */
  const rest = objs.filter((o) => !consumed.has(o.id));
  if (rest.length) structures.push({ type: 'objects', objs: rest });

  return { heapMap, structures };
}

/** Collect variable name tags per heap id + index chips, from visible frames. */
function collectVarInfo(step) {
  const tags = new Map(); // heapId -> [{name, offset, frameName, isGlobal, isTop}]
  const chips = []; // {name, value} int locals from the top frame
  const scalars = []; // [{frame, name, val}]
  const frames = step.frames;
  const top = frames[frames.length - 1];
  const globalsFrame = frames[0];
  // Globals + active frame: enough to contrast program root vs recursive locals
  const use = top === globalsFrame ? [top] : [globalsFrame, top];

  for (const f of use) {
    const isGlobal = f === globalsFrame;
    const isTop = f === top;
    for (const [name, v] of f.locals) {
      if (name === 'this') continue;
      if (isRefVal(v) && v.t === 'ref') {
        if (!tags.has(v.id)) tags.set(v.id, []);
        const list = tags.get(v.id);
        if (!list.some((t) => t.name === name && t.frameId === f.id)) {
          list.push({
            name,
            offset: v.offset || 0,
            ptr: !!v.ptr,
            frameName: f.name,
            frameId: f.id,
            isGlobal,
            isTop,
          });
        }
      } else if (v.t !== 'func' && v.t !== 'class') {
        scalars.push({ frameId: f.id, frameName: f.name, name, val: v });
        const iv = intOf(v);
        if (iv !== null && isTop && isIndexName(name)) chips.push({ name, value: iv });
      }
    }
  }
  return { tags, chips, scalars };
}

export default function CanvasPane({ isFullscreen = false, onToggleFullscreen }) {
  const { state } = useStore();
  const step = useCurrentStep();
  const prev = usePrevStep();

  const analysis = useMemo(() => (step ? analyse(step) : null), [step]);
  const prevHeapMap = useMemo(() => (prev ? buildHeapMap(prev) : new Map()), [prev]);
  const varInfo = useMemo(() => (step ? collectVarInfo(step) : null), [step]);
  const prevVarInfo = useMemo(() => (prev ? collectVarInfo(prev) : null), [prev]);

  const showEmpty = !step || state.dirty || !state.trace;

  return (
    <section className="pane canvas-pane">
      <div className="pane-header">
        Visualization
        <span className="spacer" />
        {state.trace && !state.dirty && (
          <span style={{ textTransform: 'none', letterSpacing: 0 }}>
            {state.language === 'python' ? 'Python' : state.language === 'cpp' ? 'C++' : state.language.toUpperCase()}
          </span>
        )}
        <button
          type="button"
          className={`pane-focus-btn ${isFullscreen ? 'active' : ''}`}
          title={isFullscreen ? 'Exit fullscreen (F11 / Esc)' : 'Fullscreen page (F11)'}
          onClick={onToggleFullscreen}
        >
          {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        </button>
      </div>
      <div className="canvas-scroll">
        {showEmpty ? (
          <EmptyCanvas loading={state.loading} loadError={state.loadError} dirty={state.dirty && !!state.trace} />
        ) : (
          <div className="canvas-inner">
            {state.trace?.error && !state.dirty && (
              <div className="canvas-error-banner" role="alert">
                <span className="kind">{state.trace.error.kind}</span>
                <span className="msg">{state.trace.error.message}</span>
                {state.trace.error.line != null && <span className="line">line {state.trace.error.line}</span>}
              </div>
            )}
            <StepNote step={step} code={state.code} />
            {varInfo.scalars.length > 0 && (
              <div className="viz-section">
                <div className="viz-section-title">Variables</div>
                <VarCards
                  scalars={varInfo.scalars}
                  prevScalars={prevVarInfo?.scalars ?? []}
                  heapMap={analysis.heapMap}
                />
              </div>
            )}
            {analysis.structures.length > 0 && (
              <div className="viz-section">
                <div className="viz-section-title">Memory · data structures</div>
                {analysis.structures.map((s, i) => (
                  <Structure
                    key={structureKey(s, i)}
                    s={s}
                    heapMap={analysis.heapMap}
                    prevHeapMap={prevHeapMap}
                    tags={varInfo.tags}
                    chips={varInfo.chips}
                    step={step}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function structureKey(s, i) {
  if (s.type === 'chains') return 'chains';
  if (s.type === 'objects') return 'objects';
  return `${s.type}-${s.obj.id}`;
}

function Structure({ s, heapMap, prevHeapMap, tags, chips, step }) {
  switch (s.type) {
    case 'array':
      return <ArrayView obj={s.obj} prevObj={prevHeapMap.get(s.obj.id)} heapMap={heapMap} tags={tags} chips={chips} />;
    case 'matrix':
      return <ArrayView obj={s.obj} prevObj={prevHeapMap.get(s.obj.id)} heapMap={heapMap} tags={tags} chips={chips} matrix prevHeapMap={prevHeapMap} />;
    case 'dict':
      return <DictView obj={s.obj} prevObj={prevHeapMap.get(s.obj.id)} heapMap={heapMap} tags={tags} />;
    case 'chains':
      return <ListChainView chains={s.chains} heapMap={heapMap} prevHeapMap={prevHeapMap} tags={tags} />;
    case 'tree':
      return <TreeView root={s.obj} heapMap={heapMap} prevHeapMap={prevHeapMap} tags={tags} />;
    case 'graph':
      return <GraphView obj={s.obj} heapMap={heapMap} tags={tags} step={step} />;
    case 'objects':
      return <ObjectsView objs={s.objs} heapMap={heapMap} prevHeapMap={prevHeapMap} tags={tags} />;
    default:
      return null;
  }
}

/** Parse engine notes like `if nums[j]⟦7⟧>nums[j+1]⟦3⟧ → False`. */
function parseStepNote(note, event) {
  if (!note) return { kind: event, annotation: null, boolResult: null };
  const cond = note.match(/^(if|while|for|do-while)\s+(.+?)\s*→\s*(True|False|true|false)\s*$/);
  if (cond) {
    return {
      kind: cond[1],
      annotation: cond[2].trim(),
      boolResult: /^(True|true)$/.test(cond[3]),
    };
  }
  const forIn = note.match(/^for\s+(.+)$/);
  if (forIn && event === 'line') {
    return { kind: 'for', annotation: forIn[1].trim(), boolResult: null };
  }
  if (event === 'call' || (typeof note === 'string' && note.startsWith('→'))) {
    return { kind: 'call', annotation: note, boolResult: null };
  }
  if (event === 'return') {
    return { kind: 'return', annotation: note, boolResult: null };
  }
  return { kind: event, annotation: note, boolResult: null };
}

function sourceLineAt(code, line) {
  if (!code || !line) return '';
  const lines = code.split('\n');
  return (lines[line - 1] ?? '').trim();
}

/** Render `nums[j]⟦7⟧>nums[k]⟦3⟧` with values in a faint style. */
function AnnotatedText({ text }) {
  if (!text) return null;
  const parts = text.split(/(\u27E6[^\u27E7]*\u27E7)/g);
  return (
    <span className="step-annot-line">
      {parts.map((p, i) => {
        if (p.startsWith('\u27E6') && p.endsWith('\u27E7')) {
          return (
            <span key={i} className="step-val">
              {p.slice(1, -1)}
            </span>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </span>
  );
}

function StepNote({ step, code }) {
  const src = sourceLineAt(code, step.line);
  const parsed = parseStepNote(step.note, step.event);
  const isCond =
    parsed.kind === 'if' ||
    parsed.kind === 'while' ||
    parsed.kind === 'for' ||
    parsed.kind === 'do-while';
  const isCall = step.event === 'call' || (typeof step.note === 'string' && step.note.startsWith('→'));
  const label = isCond ? parsed.kind : isCall ? 'call' : step.event;
  const evClass = isCall ? 'call' : step.event === 'return' ? 'return' : step.event;
  const hasMarkedVals = parsed.annotation && parsed.annotation.includes('\u27E6');

  return (
    <div className="step-note" key={step.i}>
      <span className={`ev ${evClass}`}>{label}</span>
      {isCond && hasMarkedVals ? (
        <AnnotatedText text={parsed.annotation} />
      ) : (
        <>
          <span className="step-src">{src || step.note || `line ${step.line}`}</span>
          {parsed.annotation && parsed.annotation !== src && !parsed.annotation.startsWith('line ') && (
            <span className="step-annot">{parsed.annotation}</span>
          )}
        </>
      )}
      {parsed.boolResult != null && (
        <span className={`step-bool ${parsed.boolResult ? 'yes' : 'no'}`}>
          {parsed.boolResult ? 'True' : 'False'}
        </span>
      )}
    </div>
  );
}

function EmptyCanvas({ loading, loadError, dirty }) {
  return (
    <div className="canvas-empty">
      <div className="orb">{loading ? '◌' : '◈'}</div>
      <h3>
        {loading
          ? 'Tracing your program…'
          : loadError
            ? 'Could not trace'
            : dirty
              ? 'Code changed'
              : 'Ready to visualize'}
      </h3>
      <p>
        {loading
          ? 'The engine is recording every step, variable and heap object.'
          : loadError
            ? loadError
            : dirty
              ? 'Press Visualize to re-trace the program and watch it run.'
              : 'Press Visualize to run your code and watch every variable, array, pointer and call come alive.'}
      </p>
    </div>
  );
}
