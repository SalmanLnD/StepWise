import React, { useMemo } from 'react';
import { fmtVal, isRefVal } from '../../utils/format.js';

const R = 21;

/** Adjacency map rendered as a circular-layout interactive graph. */
export default function GraphView({ obj, heapMap, tags, step }) {
  const { nodes, edges, size } = useMemo(() => {
    const keys = obj.entries.map(([k]) => fmtVal(k, heapMap, 0).replace(/^"|"$/g, ''));
    const idx = new Map(keys.map((k, i) => [k, i]));
    const n = keys.length;
    const radius = Math.max(85, n * 26);
    const size = radius * 2 + 90;
    const cx = size / 2;
    const cy = size / 2;
    const nodes = keys.map((k, i) => {
      const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
      return { key: k, x: cx + radius * Math.cos(ang), y: cy + radius * Math.sin(ang) };
    });
    const edges = [];
    obj.entries.forEach(([k, v], i) => {
      if (!isRefVal(v)) return;
      const nbrs = heapMap.get(v.id);
      if (!nbrs) return;
      for (const nb of nbrs.items) {
        const label = fmtVal(nb, heapMap, 0).replace(/^"|"$/g, '');
        const j = idx.get(label);
        if (j !== undefined) edges.push({ from: i, to: j });
      }
    });
    return { nodes, edges, size };
  }, [obj, heapMap]);

  // highlight sets from well-known variable names
  const { visited, queued, current } = useMemo(() => {
    const visited = new Set();
    const queued = new Set();
    let current = null;
    const top = step.frames[step.frames.length - 1];
    const frames = top === step.frames[0] ? [top] : [step.frames[0], top];
    for (const f of frames) {
      for (const [name, v] of f.locals) {
        const lname = name.toLowerCase();
        if (isRefVal(v)) {
          const t = heapMap.get(v.id);
          if (!t || (t.kind !== 'array' && t.kind !== 'set')) continue;
          const labels = t.items.map((x) => fmtVal(x, heapMap, 0).replace(/^"|"$/g, ''));
          if (lname === 'visited' || lname === 'seen') labels.forEach((l) => visited.add(l));
          if (lname === 'queue' || lname === 'stack' || lname === 'frontier') labels.forEach((l) => queued.add(l));
        } else if (['node', 'cur', 'current', 'u'].includes(lname) && v.t === 'str') {
          current = v.v;
        }
      }
    }
    return { visited, queued, current };
  }, [step, heapMap]);

  return (
    <div className="struct-card">
      <div className="struct-title">
        <span className="badge">graph</span>
        <span className="lbl">{obj.label} · adjacency</span>
        <span className="var-tags">
          {(tags.get(obj.id) ?? []).map((t) => (
            <span key={t.name} className="var-tag">
              {t.name}
            </span>
          ))}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, fontSize: 10 }}>
          <span style={{ color: 'var(--green)' }}>● visited</span>
          <span style={{ color: 'var(--amber)' }}>● in queue</span>
        </span>
      </div>
      <svg width={size} height={size} style={{ display: 'block', margin: '0 auto', maxWidth: '100%' }}>
        {edges.map((e, i) => {
          const a = nodes[e.from];
          const b = nodes[e.to];
          return <line key={i} className="graph-edge" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
        })}
        {nodes.map((n) => {
          const isVisited = visited.has(n.key);
          const isQueued = queued.has(n.key);
          const isCurrent = current === n.key;
          const fill = isCurrent
            ? 'var(--accent)'
            : isVisited
              ? 'var(--green-soft)'
              : isQueued
                ? 'var(--amber-soft)'
                : 'var(--bg-3)';
          const stroke = isCurrent
            ? 'var(--accent)'
            : isVisited
              ? 'var(--green)'
              : isQueued
                ? 'var(--amber)'
                : 'var(--border-strong)';
          return (
            <g key={n.key} className="graph-node">
              <circle cx={n.x} cy={n.y} r={isCurrent ? R + 3 : R} fill={fill} stroke={stroke} strokeWidth="2" />
              <text
                x={n.x}
                y={n.y + 4.5}
                textAnchor="middle"
                fontSize="13"
                style={{ fill: isCurrent ? '#fff' : 'var(--text-0)' }}
              >
                {n.key}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
