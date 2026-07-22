import React from 'react';
import { fmtVal, sameVal } from '../../utils/format.js';

export default function VarCards({ scalars, prevScalars, heapMap }) {
  const prevMap = new Map(prevScalars.map((s) => [`${s.frameId}:${s.name}`, s.val]));

  return (
    <div className="var-grid">
      {scalars.map(({ frameId, frameName, name, val }) => {
        const key = `${frameId}:${name}`;
        const pv = prevMap.get(key);
        const changed = pv !== undefined && !sameVal(pv, val);
        const typeLabel = val.t === 'num' ? (Number.isInteger(val.v) ? 'int' : 'float') : val.t;
        return (
          <div key={key} className={`var-card ${changed ? 'changed' : ''}`}>
            {changed ? (
              <span className="var-old">{fmtVal(pv, heapMap, 0)}</span>
            ) : (
              <span className="var-type">{typeLabel}</span>
            )}
            <div className="var-name">{name}</div>
            <div className="var-value" key={fmtVal(val, heapMap, 0)}>
              {fmtVal(val, heapMap, 0)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
