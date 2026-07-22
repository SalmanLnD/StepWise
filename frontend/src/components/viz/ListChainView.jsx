import React, { useRef, useLayoutEffect, useState } from 'react';
import { isRefVal } from '../../utils/format.js';
import { useFlip } from '../../utils/flip.js';
import { ObjectCard } from './ObjectsView.jsx';

/**
 * Linked-list chains with live SVG pointer arrows between nodes.
 * Arrows re-measure after FLIP movements settle, so pointer flips
 * (e.g. list reversal) animate visibly.
 */
export default function ListChainView({ chains, heapMap, prevHeapMap, tags }) {
  const wrapRef = useRef(null);
  const [arrows, setArrows] = useState([]);

  const allNodes = chains.flat();
  const sig = allNodes
    .map((o) => `${o.id}:${o.fields.map(([k, v]) => `${k}=${isRefVal(v) ? 'r' + v.id : v?.v}`).join(',')}`)
    .join('|');

  useFlip(wrapRef, sig);

  useLayoutEffect(() => {
    const measure = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const wrapRect = wrap.getBoundingClientRect();
      const rects = new Map();
      for (const el of wrap.querySelectorAll('[data-node-id]')) {
        rects.set(+el.dataset.nodeId, el.getBoundingClientRect());
      }
      const out = [];
      for (const node of allNodes) {
        for (const [k, v] of node.fields) {
          if (k !== 'next' && k !== 'prev') continue;
          if (!isRefVal(v)) continue;
          const from = rects.get(node.id);
          const to = rects.get(v.id);
          if (!from || !to) continue;
          const fx = from.right - wrapRect.left;
          const fy = from.top + from.height / 2 - wrapRect.top;
          const goingRight = to.left >= from.right - 4;
          const tx = (goingRight ? to.left : to.right) - wrapRect.left;
          const ty = to.top + to.height / 2 - wrapRect.top;
          let d;
          if (goingRight && Math.abs(ty - fy) < 8) {
            d = `M ${fx + 2} ${fy} L ${tx - 6} ${ty}`;
          } else {
            const lift = k === 'prev' ? 34 : -30;
            const midY = Math.min(fy, ty) + lift;
            d = `M ${fx + 2} ${fy} C ${fx + 40} ${midY}, ${tx - 40} ${midY}, ${tx - 6} ${ty}`;
          }
          out.push({ id: `${node.id}-${k}`, d, prev: k === 'prev' });
        }
      }
      setArrows(out);
    };
    measure();
    const t1 = setTimeout(measure, 200);
    const t2 = setTimeout(measure, 430);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [sig]);

  return (
    <div className="struct-card" style={{ alignSelf: 'stretch' }}>
      <div className="struct-title">
        <span className="badge">linked list</span>
        <span className="lbl">
          {allNodes.length} node{allNodes.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div ref={wrapRef} style={{ position: 'relative' }}>
        <svg
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1, overflow: 'visible' }}
        >
          <defs>
            <marker id="sw-arrowhead" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 z" fill="var(--accent)" />
            </marker>
            <marker id="sw-arrowhead-pink" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 z" fill="var(--pink)" />
            </marker>
          </defs>
          {arrows.map((a) => (
            <path
              key={a.id}
              className="arrow-path arrow-active"
              d={a.d}
              stroke={a.prev ? 'var(--pink)' : 'var(--accent)'}
              markerEnd={a.prev ? 'url(#sw-arrowhead-pink)' : 'url(#sw-arrowhead)'}
            />
          ))}
        </svg>
        {chains.map((chain, ci) => (
          <div className="list-flow" key={chain[0]?.id ?? ci}>
            {chain.map((node) => (
              <div className="list-node-wrap" key={node.id} data-flip-key={`n${node.id}`}>
                <ObjectCard
                  obj={node}
                  prevObj={prevHeapMap.get(node.id)}
                  heapMap={heapMap}
                  tagNames={(tags.get(node.id) ?? []).map((t) => t.name)}
                  nodeId={node.id}
                />
              </div>
            ))}
            <div style={{ color: 'var(--text-2)', fontFamily: 'var(--font-mono)', fontSize: 11, flex: 'none' }}>∅</div>
          </div>
        ))}
      </div>
    </div>
  );
}
