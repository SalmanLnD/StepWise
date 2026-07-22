import React, { useMemo } from 'react';
import { fmtVal, isRefVal, sameVal } from '../../utils/format.js';

const NODE_W = 58;
const LEVEL_H = 74;
const R = 21;

function layoutTree(root, heapMap) {
  const nodes = [];
  const edges = [];
  let nextX = 0; // Knuth layout: x = in-order visit index, guarantees no overlap

  const fieldOf = (o, name) => o.fields.find(([k]) => k === name)?.[1];
  const childOf = (o, name) => {
    const v = fieldOf(o, name);
    return v && isRefVal(v) ? heapMap.get(v.id) : null;
  };
  const labelOf = (o) => {
    const f = o.fields.find(([k]) => !['left', 'right', 'next', 'parent'].includes(k));
    return f ? fmtVal(f[1], heapMap, 0) : '?';
  };

  const walk = (o, depth, seen) => {
    if (!o || seen.has(o.id)) return;
    seen.add(o.id);
    const left = childOf(o, 'left');
    const right = childOf(o, 'right');
    if (left) {
      edges.push({ from: o.id, to: left.id });
      walk(left, depth + 1, seen);
    }
    nodes.push({ id: o.id, x: nextX++, depth, label: labelOf(o), obj: o });
    if (right) {
      edges.push({ from: o.id, to: right.id });
      walk(right, depth + 1, seen);
    }
  };

  walk(root, 0, new Set());
  const width = (Math.max(...nodes.map((n) => n.x), 0) + 1) * NODE_W + 20;
  const height = (Math.max(...nodes.map((n) => n.depth), 0) + 1) * LEVEL_H + 16;
  return { nodes, edges, width, height };
}

export default function TreeView({ root, heapMap, prevHeapMap, tags }) {
  const { nodes, edges, width, height } = useMemo(() => layoutTree(root, heapMap), [root, heapMap]);
  const pos = new Map(nodes.map((n) => [n.id, { cx: n.x * NODE_W + NODE_W / 2 + 8, cy: n.depth * LEVEL_H + R + 12 }]));

  return (
    <div className="struct-card tree-svg-wrap">
      <div className="struct-title">
        <span className="badge">tree</span>
        <span className="lbl">{root.label}</span>
        <span className="var-tags">
          {(tags.get(root.id) ?? []).map((t) => (
            <span key={t.name} className="var-tag">
              {t.name}
            </span>
          ))}
        </span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
          {nodes.length} nodes
        </span>
      </div>
      <div style={{ position: 'relative', width, height }}>
        <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
          {edges.map((e) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            return (
              <path
                key={`${e.from}-${e.to}`}
                className="tree-edge"
                d={`M ${a.cx} ${a.cy + R - 4} C ${a.cx} ${a.cy + 34}, ${b.cx} ${b.cy - 34}, ${b.cx} ${b.cy - R + 4}`}
              />
            );
          })}
        </svg>
        {nodes.map((n) => {
          const p = pos.get(n.id);
          const prev = prevHeapMap.get(n.id);
          const isNew = !prev;
          const changed =
            prev &&
            n.obj.fields.some(([k, v]) => {
              const pv = prev.fields.find(([pk]) => pk === k)?.[1];
              return pv !== undefined && !sameVal(pv, v);
            });
          const nodeTags = (tags.get(n.id) ?? []).map((t) => t.name);
          return (
            <div
              key={n.id}
              style={{
                position: 'absolute',
                left: p.cx - R,
                top: p.cy - R,
                width: R * 2,
                height: R * 2,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                background: nodeTags.length ? 'var(--accent-2-soft)' : 'var(--bg-3)',
                border: `2px solid ${changed ? 'var(--accent)' : nodeTags.length ? 'var(--accent-2)' : 'var(--border-strong)'}`,
                boxShadow: nodeTags.length ? 'var(--glow-cyan)' : changed ? 'var(--glow-accent)' : 'none',
                fontFamily: 'var(--font-mono)',
                fontWeight: 700,
                fontSize: 13,
                transition: 'left 380ms cubic-bezier(0.22,1,0.36,1), top 380ms cubic-bezier(0.22,1,0.36,1), border-color 250ms, background 250ms',
                animation: isNew ? 'sw-pop-in 480ms cubic-bezier(0.34,1.56,0.64,1)' : 'none',
                zIndex: 2,
              }}
            >
              {n.label}
              {nodeTags.length > 0 && (
                <div className="node-var-tags" style={{ top: -15 }}>
                  {nodeTags.map((t) => (
                    <span key={t} className="ptr-chip">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
