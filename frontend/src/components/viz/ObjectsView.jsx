import React from 'react';
import { fmtVal, sameVal } from '../../utils/format.js';

export function ObjectCard({ obj, prevObj, heapMap, tagNames = [], pointed = false, nodeId }) {
  return (
    <div
      className={`obj-card ${pointed || tagNames.length ? 'pointed' : ''} ${obj.freed ? 'freed' : ''}`}
      data-node-id={nodeId ?? obj.id}
    >
      {tagNames.length > 0 && (
        <div className="node-var-tags">
          {tagNames.map((n) => (
            <span key={n} className="ptr-chip">
              {n}
            </span>
          ))}
        </div>
      )}
      <div className="obj-type">
        {obj.label} <span style={{ opacity: 0.6 }}>#{obj.id}</span>
      </div>
      {obj.fields.map(([k, v]) => {
        const pv = prevObj?.fields?.find(([pk]) => pk === k)?.[1];
        const changed = prevObj && pv !== undefined && !sameVal(pv, v);
        return (
          <div key={k} className={`obj-field ${changed ? 'changed' : ''}`}>
            <span className="fname">{k}</span>
            <span className="fval" key={fmtVal(v, heapMap, 0)}>
              {fmtVal(v, heapMap, 0)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function ObjectsView({ objs, heapMap, prevHeapMap, tags }) {
  return (
    <div className="struct-card">
      <div className="struct-title">
        <span className="badge">objects</span>
        <span className="lbl">heap objects</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 22, paddingTop: 14 }}>
        {objs.map((o) => (
          <ObjectCard
            key={o.id}
            obj={o}
            prevObj={prevHeapMap.get(o.id)}
            heapMap={heapMap}
            tagNames={(tags.get(o.id) ?? []).map((t) => t.name)}
          />
        ))}
      </div>
    </div>
  );
}
