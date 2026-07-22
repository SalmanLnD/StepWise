import React from 'react';
import { fmtVal, sameVal } from '../../utils/format.js';
import { Title } from './ArrayView.jsx';

export default function DictView({ obj, prevObj, heapMap, tags }) {
  const tagNames = (tags.get(obj.id) ?? []).map((t) => t.name);
  const prevEntries = prevObj ? new Map(prevObj.entries.map(([k, v]) => [JSON.stringify(k), v])) : null;

  return (
    <div className="struct-card">
      <Title obj={obj} tagNames={tagNames} badge="map" />
      {obj.entries.length === 0 ? (
        <div style={{ color: 'var(--text-2)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>(empty)</div>
      ) : (
        <div className="dict-rows">
          {obj.entries.map(([k, v], i) => {
            const kk = JSON.stringify(k);
            const pv = prevEntries?.get(kk);
            const isNew = prevEntries !== null && pv === undefined;
            const changed = pv !== undefined && !sameVal(pv, v);
            return (
              <div key={kk} className={`dict-row ${changed || isNew ? 'changed' : ''}`}>
                <span className="k">{fmtVal(k, heapMap, 0)}</span>
                <span className="arrow">→</span>
                <span className="v" key={fmtVal(v, heapMap, 0)}>
                  {fmtVal(v, heapMap, 1)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
