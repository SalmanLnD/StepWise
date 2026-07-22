import React, { useRef } from 'react';
import { fmtVal, sameVal } from '../../utils/format.js';
import { useFlip, flipKeys } from '../../utils/flip.js';

function cellText(v, heapMap) {
  if (v == null) return '·';
  if (v.t === 'str') return v.v.length > 8 ? `"${v.v.slice(0, 7)}…"` : `"${v.v}"`;
  if (v.t === 'char') return v.v === '\0' ? '␀' : v.v;
  if (v.t === 'ref') {
    const t = heapMap.get(v.id);
    return t ? `→${t.label.split('[')[0].split('{')[0] || '#'}${v.id}` : '→?';
  }
  return fmtVal(v, heapMap, 0);
}

/**
 * Arrays, sets, stacks, queues and (with matrix=true) 2-D matrices.
 */
export default function ArrayView({ obj, prevObj, heapMap, tags, chips, matrix = false, prevHeapMap }) {
  const rowRef = useRef(null);
  const sig = matrix ? null : obj.items.map((v) => fmtVal(v, heapMap, 0)).join('|');
  useFlip(rowRef, sig);

  const myTags = tags.get(obj.id) ?? [];
  const tagNames = myTags.filter((t) => !t.offset).map((t) => t.name);
  const offsetPtrs = myTags.filter((t) => t.offset > 0 || t.ptr);
  const isStackLike = /^(stack|Stack)$/.test(obj.label);
  const isQueueLike = /^(queue|ArrayDeque|LinkedList|PriorityQueue)$/.test(obj.label);
  const isSet = obj.kind === 'set';

  if (matrix) {
    return (
      <div className={`struct-card ${obj.freed ? 'freed' : ''}`}>
        <Title obj={obj} tagNames={tagNames} badge="matrix" />
        <div className="matrix">
          {obj.items.map((rowRefVal, ri) => {
            const row = heapMap.get(rowRefVal.id);
            const prevRow = prevHeapMap?.get(rowRefVal.id);
            if (!row) return null;
            return (
              <div className="array-row" key={rowRefVal.id}>
                <span className="matrix-rowidx">{ri}</span>
                {row.items.map((v, ci) => {
                  const pv = prevRow?.items?.[ci];
                  const changed = prevRow && pv !== undefined && !sameVal(pv, v);
                  return (
                    <div key={ci} className={`acell ${changed ? 'changed' : ''}`}>
                      <div className="acell-box">{cellText(v, heapMap)}</div>
                      {ri === obj.items.length - 1 && <span className="acell-idx">{ci}</span>}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const keys = flipKeys(obj.items, (v) => fmtVal(v, heapMap, 0));
  const prevItems = prevObj?.items ?? null;
  const chipFor = (i) => {
    const list = [];
    for (const c of chips ?? []) {
      if (c.value === i && i < obj.items.length) list.push({ name: c.name, alt: false });
    }
    for (const p of offsetPtrs) {
      if ((p.offset || 0) === i) list.push({ name: p.name, alt: true });
    }
    return list;
  };
  const badge = isSet ? 'set' : isStackLike ? 'stack' : isQueueLike ? 'queue' : obj.label === 'tuple' ? 'tuple' : 'array';

  return (
    <div className={`struct-card ${obj.freed ? 'freed' : ''}`}>
      <Title obj={obj} tagNames={tagNames} badge={badge} freed={obj.freed} />
      {obj.items.length === 0 ? (
        <div style={{ color: 'var(--text-2)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>(empty)</div>
      ) : (
        <div className="array-row" ref={rowRef}>
          {obj.items.map((v, i) => {
            const pv = prevItems ? prevItems[i] : undefined;
            const changed = prevItems !== null && pv !== undefined && !sameVal(pv, v);
            const inserted = prevItems !== null && i >= prevItems.length;
            const cellChips = chipFor(i);
            const pointed = cellChips.length > 0;
            return (
              <div
                key={keys[i]}
                data-flip-key={keys[i]}
                className={`acell ${changed ? 'changed' : ''} ${inserted ? 'inserted' : ''} ${pointed ? 'pointed' : ''}`}
              >
                <div className="acell-box">{cellText(v, heapMap)}</div>
                {!isSet && <span className="acell-idx">{i}</span>}
                <div className="acell-pointers">
                  {cellChips.map((c) => (
                    <span key={c.name} className={`ptr-chip ${c.alt ? 'alt' : ''}`}>
                      {c.name}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
          {isStackLike && (
            <div style={{ alignSelf: 'center', color: 'var(--text-2)', fontSize: 10, marginLeft: 6, fontWeight: 700 }}>
              ← top
            </div>
          )}
          {isQueueLike && obj.items.length > 0 && (
            <div style={{ alignSelf: 'center', color: 'var(--text-2)', fontSize: 10, marginLeft: 6, fontWeight: 700 }}>
              ← rear
            </div>
          )}
        </div>
      )}
      {isQueueLike && obj.items.length > 0 && (
        <div style={{ color: 'var(--text-2)', fontSize: 10, fontWeight: 700, marginTop: 2 }}>front ↑ index 0</div>
      )}
    </div>
  );
}

export function Title({ obj, tagNames, badge, freed }) {
  return (
    <div className="struct-title">
      <span className="badge">{badge}</span>
      <span className="lbl">{obj.label}</span>
      {freed && <span className="badge freed-badge">freed</span>}
      {tagNames.length > 0 && (
        <span className="var-tags">
          {tagNames.map((n) => (
            <span key={n} className="var-tag">
              {n}
            </span>
          ))}
        </span>
      )}
      <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10 }}>#{obj.id}</span>
    </div>
  );
}
