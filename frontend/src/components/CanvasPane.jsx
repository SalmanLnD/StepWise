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
import FramesView from './viz/FramesView.jsx';

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

export default function CanvasPane() {
  const { state } = useStore();
  const step = useCurrentStep();
  const prev = usePrevStep();

  const analysis = useMemo(() => (step ? analyse(step) : null), [step]);
  const prevHeapMap = useMemo(() => (prev ? buildHeapMap(prev) : new Map()), [prev]);
  const varInfo = useMemo(() => (step ? collectVarInfo(step) : null), [step]);
  const prevVarInfo = useMemo(() => (prev ? collectVarInfo(prev) : null), [prev]);

  const showEmpty = !step || state.dirty || !state.trace;

  return (
    <section className="pane">
      <div className="pane-header">
        Visualization
        <span className="spacer" />
        {state.trace && !state.dirty && (
          <span style={{ textTransform: 'none', letterSpacing: 0 }}>
            {state.language === 'python' ? 'Python' : state.language === 'cpp' ? 'C++' : state.language.toUpperCase()}
          </span>
        )}
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
            <StepNote step={step} />
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
            {step.frames.length > 2 && (
              <div className="viz-section">
                <div className="viz-section-title">Call stack · recursion</div>
                <FramesView step={step} prev={prev} heapMap={analysis.heapMap} />
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

function StepNote({ step }) {
  return (
    <div className="step-note" key={step.i}>
      <span className={`ev ${step.event}`}>{step.event}</span>
      <span>{step.note || `line ${step.line}`}</span>
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
