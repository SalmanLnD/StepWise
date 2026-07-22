/** Helpers for working with the trace wire format. */

export function buildHeapMap(step) {
  const m = new Map();
  if (step) for (const o of step.heap) m.set(o.id, o);
  return m;
}

export function isRefVal(v) {
  return v && (v.t === 'ref' || v.t === 'stackref');
}

export function isScalarVal(v) {
  return !isRefVal(v);
}

/** Short text for a scalar or a shallow preview for refs. */
export function fmtVal(v, heapMap, depth = 1) {
  if (v == null) return '·';
  switch (v.t) {
    case 'num': {
      if (typeof v.v === 'number' && !Number.isInteger(v.v)) {
        return String(Math.round(v.v * 10000) / 10000);
      }
      return String(v.v);
    }
    case 'str':
      return `"${v.v}"`;
    case 'char':
      return `'${v.v === '\0' ? '\\0' : v.v}'`;
    case 'bool':
      return String(v.v);
    case 'null':
      return v.v;
    case 'func':
      return `ƒ ${v.v}`;
    case 'class':
      return `class ${v.v}`;
    case 'stackref':
      return `→ ${v.name}`;
    case 'ref': {
      const obj = heapMap?.get(v.id);
      if (!obj) return '→ ?';
      if (depth <= 0) return `→ ${obj.label}`;
      return previewObj(obj, heapMap, depth);
    }
    default:
      return String(v.v ?? '?');
  }
}

export function previewObj(obj, heapMap, depth = 1) {
  if (obj.kind === 'array') {
    const inner = obj.items.slice(0, 8).map((x) => fmtVal(x, heapMap, depth - 1));
    return `[${inner.join(', ')}${obj.items.length > 8 ? ', …' : ''}]`;
  }
  if (obj.kind === 'set') {
    const inner = obj.items.slice(0, 8).map((x) => fmtVal(x, heapMap, depth - 1));
    return `{${inner.join(', ')}}`;
  }
  if (obj.kind === 'map') {
    const inner = obj.entries
      .slice(0, 5)
      .map(([k, val]) => `${fmtVal(k, heapMap, 0)}: ${fmtVal(val, heapMap, depth - 1)}`);
    return `{${inner.join(', ')}${obj.entries.length > 5 ? ', …' : ''}}`;
  }
  const fs = obj.fields.slice(0, 4).map(([k, val]) => `${k}: ${fmtVal(val, heapMap, 0)}`);
  return `${obj.label} {${fs.join(', ')}}`;
}

/** Raw scalar for pointer-chip matching (ints only). */
export function intOf(v) {
  return v && v.t === 'num' && Number.isInteger(v.v) ? v.v : null;
}

export function sameVal(a, b) {
  if (a == null || b == null) return a === b;
  if (a.t !== b.t) return false;
  if (a.t === 'ref') return a.id === b.id && (a.offset || 0) === (b.offset || 0);
  if (a.t === 'stackref') return a.name === b.name && a.frame === b.frame;
  return a.v === b.v;
}

/** Names commonly used as array indices — used for pointer chips. */
const INDEX_NAMES = new Set([
  'i', 'j', 'k', 'l', 'r', 'lo', 'hi', 'mid', 'low', 'high', 'left', 'right',
  'start', 'end', 'pos', 'idx', 'index', 'front', 'rear', 'top', 'p', 'q',
  'slow', 'fast', 'minidx', 'maxidx',
]);

export function isIndexName(name) {
  return INDEX_NAMES.has(name.toLowerCase());
}
