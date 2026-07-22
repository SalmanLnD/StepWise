import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useStore, useCurrentStep, usePrevStep } from '../store.jsx';
import { buildHeapMap, fmtVal, previewObj, sameVal } from '../utils/format.js';

const TABS = ['Stack', 'Heap', 'Console', 'Stats'];

export default function RightPanel() {
  const [tab, setTab] = useState('Stack');
  const { state } = useStore();
  const step = useCurrentStep();
  const err = state.trace?.error;

  return (
    <section className="pane">
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {err && !state.dirty && (
        <div className="error-banner">
          ⚠ {err.kind}: {err.message}
        </div>
      )}
      <div className="tab-body">
        {!step || state.dirty ? (
          <div className="empty-hint">
            <span className="big">◇</span>
            Run a trace to inspect the
            <br />
            call stack, heap and console.
          </div>
        ) : (
          <>
            {tab === 'Stack' && <StackTab step={step} />}
            {tab === 'Heap' && <HeapTab step={step} />}
            {tab === 'Console' && <ConsoleTab step={step} />}
            {tab === 'Stats' && <StatsTab step={step} />}
          </>
        )}
      </div>
    </section>
  );
}

function StackTab({ step }) {
  const { state, dispatch } = useStore();
  const prev = usePrevStep();
  const [watchInput, setWatchInput] = useState('');
  const heapMap = useMemo(() => buildHeapMap(step), [step]);
  const prevLocals = useMemo(() => {
    const m = new Map();
    if (prev) for (const f of prev.frames) m.set(f.id, new Map(f.locals));
    return m;
  }, [prev]);

  const resolveWatch = (name) => {
    for (let i = step.frames.length - 1; i >= 0; i--) {
      const f = step.frames[i];
      const hit = f.locals.find(([n]) => n === name);
      if (hit) return { value: hit[1], frame: f.name, frameId: f.id };
    }
    return null;
  };

  const resolvePrevWatch = (name) => {
    if (!prev) return null;
    for (let i = prev.frames.length - 1; i >= 0; i--) {
      const hit = prev.frames[i].locals.find(([n]) => n === name);
      if (hit) return hit[1];
    }
    return null;
  };

  const addWatch = () => {
    const name = watchInput.trim();
    if (!name) return;
    dispatch({ type: 'ADD_WATCH', name });
    setWatchInput('');
  };

  return (
    <>
      <div className="depth-meter">
        depth {step.frames.length}
        <div className="bars">
          {step.frames.map((f) => (
            <span key={f.id} className="bar" />
          ))}
        </div>
      </div>

      <div className="watch-panel">
        <div className="watch-head">
          <span className="watch-title">Watch</span>
          <form
            className="watch-add"
            onSubmit={(e) => {
              e.preventDefault();
              addWatch();
            }}
          >
            <input
              type="text"
              placeholder="variable name"
              value={watchInput}
              onChange={(e) => setWatchInput(e.target.value)}
              spellCheck={false}
            />
            <button type="submit" disabled={!watchInput.trim()} title="Add watch">
              +
            </button>
          </form>
        </div>
        {state.watches.length === 0 ? (
          <div className="watch-empty">Add names to track across steps</div>
        ) : (
          <div className="watch-list">
            {state.watches.map((name) => {
              const cur = resolveWatch(name);
              const prevVal = resolvePrevWatch(name);
              const changed = cur && prevVal !== null && !sameVal(prevVal, cur.value);
              const fresh = cur && prevVal === null && prev;
              return (
                <div key={name} className={`watch-row ${changed || fresh ? 'changed' : ''} ${!cur ? 'missing' : ''}`}>
                  <div className="watch-meta">
                    <b>{name}</b>
                    {cur && <span className="watch-frame">{cur.frame}</span>}
                    <button
                      type="button"
                      className="watch-remove"
                      title="Remove watch"
                      onClick={() => dispatch({ type: 'REMOVE_WATCH', name })}
                    >
                      ×
                    </button>
                  </div>
                  <div className="watch-val">
                    {cur ? fmtVal(cur.value, heapMap, 1) : <span className="watch-undef">not in scope</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="frames-col">
        {step.frames.map((f, fi) => {
          const isTop = fi === step.frames.length - 1;
          const pl = prevLocals.get(f.id);
          return (
            <div key={f.id} className={`frame-card ${isTop ? 'top' : ''}`}>
              <div className="frame-name">
                {f.name}
                <span className="frame-line">line {f.line ?? '—'}</span>
              </div>
              {f.locals.length > 0 && (
                <div className="frame-vars">
                  {f.locals
                    .filter(([n]) => n !== 'this' || isTop)
                    .map(([n, v]) => {
                      const changed = pl && pl.has(n) && !sameVal(pl.get(n), v);
                      const fresh = pl && !pl.has(n);
                      return (
                        <span key={n} className={`fv ${changed || fresh ? 'changed' : ''}`}>
                          <b
                            className="fv-name"
                            title="Add to watch"
                            onClick={() => dispatch({ type: 'ADD_WATCH', name: n })}
                          >
                            {n}
                          </b>{' '}
                          = {fmtVal(v, heapMap, 1)}
                        </span>
                      );
                    })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function HeapTab({ step }) {
  const heapMap = useMemo(() => buildHeapMap(step), [step]);
  if (step.heap.length === 0) {
    return (
      <div className="empty-hint">
        <span className="big">▦</span>
        Heap is empty — nothing has
        <br />
        been allocated yet.
      </div>
    );
  }
  return (
    <>
      {step.heap.map((o) => (
        <div key={o.id} className={`heap-item ${o.freed ? 'freed' : ''}`}>
          <div className="heap-head">
            <span className="heap-id">#{o.id}</span>
            {o.label}
            {o.freed && <span style={{ color: 'var(--red)', fontSize: 10 }}>freed</span>}
            <span style={{ marginLeft: 'auto', color: 'var(--text-2)', fontWeight: 400 }}>
              {o.kind === 'map' ? `${o.entries.length} entries` : o.kind === 'object' ? `${o.fields.length} fields` : `${o.items.length} items`}
            </span>
          </div>
          <div className="heap-preview">{previewObj(o, heapMap, 1)}</div>
        </div>
      ))}
    </>
  );
}

function ConsoleTab({ step }) {
  const prev = usePrevStep();
  const scroller = useRef(null);
  const oldPart = prev ? prev.stdout : '';
  const newPart = step.stdout.slice(oldPart.length);

  useEffect(() => {
    scroller.current?.scrollIntoView({ block: 'end' });
  }, [step.stdout]);

  return (
    <div className="console-out">
      {step.stdout.length === 0 && <span style={{ color: 'var(--text-2)' }}>— no output yet —</span>}
      <span>{oldPart.slice(0, step.stdout.length - newPart.length)}</span>
      {newPart && <span className="new-out">{newPart}</span>}
      <span className="console-caret" ref={scroller} />
    </div>
  );
}

function StatsTab({ step }) {
  const { state } = useStore();
  const trace = state.trace;
  const executedLines = useMemo(() => {
    const s = new Set();
    for (let i = 0; i <= state.stepIndex; i++) s.add(trace.steps[i].line);
    return s.size;
  }, [trace, state.stepIndex]);
  const liveObjects = step.heap.filter((o) => !o.freed).length;
  const cells = step.heap.reduce(
    (acc, o) => acc + (o.kind === 'map' ? o.entries.length : o.kind === 'object' ? o.fields.length : o.items.length),
    0
  );

  return (
    <div className="stat-grid">
      <div className="stat-card">
        <div className="s-label">Step</div>
        <div className="s-value accent">
          {state.stepIndex + 1}
          <span style={{ fontSize: 12, color: 'var(--text-2)' }}> / {trace.steps.length}</span>
        </div>
      </div>
      <div className="stat-card">
        <div className="s-label">Current line</div>
        <div className="s-value cyan">{step.line}</div>
      </div>
      <div className="stat-card">
        <div className="s-label">Call depth</div>
        <div className="s-value">{step.frames.length}</div>
      </div>
      <div className="stat-card">
        <div className="s-label">Lines executed</div>
        <div className="s-value">{executedLines}</div>
      </div>
      <div className="stat-card">
        <div className="s-label">Live heap objects</div>
        <div className="s-value">{liveObjects}</div>
      </div>
      <div className="stat-card">
        <div className="s-label">Memory cells</div>
        <div className="s-value">{cells}</div>
      </div>
      <div className="stat-card wide">
        <div className="s-label">Total allocations</div>
        <div className="s-value">{trace.allocCount}</div>
      </div>
      {trace.truncated && (
        <div className="stat-card wide" style={{ borderColor: 'var(--amber)' }}>
          <div className="s-label" style={{ color: 'var(--amber)' }}>Trace truncated</div>
          <div style={{ fontSize: 12, color: 'var(--text-1)', marginTop: 4 }}>
            Execution exceeded the step limit; showing the first {trace.steps.length} steps.
          </div>
        </div>
      )}
    </div>
  );
}
