import React from 'react';
import { fmtVal, sameVal } from '../../utils/format.js';

/** Recursion visual: the live frame stack rendered on the canvas. */
export default function FramesView({ step, prev, heapMap }) {
  const prevIds = new Set(prev?.frames.map((f) => f.id) ?? []);
  const frames = step.frames.slice(1); // skip globals/module

  return (
    <div className="frames-col" style={{ maxWidth: 460 }}>
      {frames.map((f, i) => {
        const isTop = i === frames.length - 1;
        const isNew = !prevIds.has(f.id);
        const pf = prev?.frames.find((x) => x.id === f.id);
        const pl = pf ? new Map(pf.locals) : null;
        return (
          <div
            key={f.id}
            className={`frame-card ${isTop ? 'top' : ''}`}
            style={{
              marginLeft: i * 14,
              animation: isNew ? 'sw-frame-in 380ms cubic-bezier(0.34,1.56,0.64,1)' : 'none',
            }}
          >
            <div className="frame-name">
              <span style={{ color: 'var(--text-2)', fontWeight: 400, fontSize: 10 }}>{i + 1}</span>
              {f.name}()
              <span className="frame-line">line {f.line ?? '—'}</span>
            </div>
            <div className="frame-vars">
              {f.locals
                .filter(([n]) => n !== 'this')
                .map(([n, v]) => {
                  const changed = pl && pl.has(n) && !sameVal(pl.get(n), v);
                  return (
                    <span key={n} className={`fv ${changed ? 'changed' : ''}`}>
                      <b>{n}</b> = {fmtVal(v, heapMap, 0)}
                    </span>
                  );
                })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
