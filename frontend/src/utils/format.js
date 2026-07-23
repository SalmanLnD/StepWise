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

/**
 * Parse a watch expression into path segments.
 * Supports: root, root.key, root.left.key, nums[0], nums[i], arr[0].x
 */
export function parseWatchPath(path) {
  const s = (path || '').trim();
  if (!s) return null;
  const tokens = [];
  let i = 0;
  const ident = () => {
    const m = s.slice(i).match(/^[A-Za-z_][\w]*/);
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const first = ident();
  if (!first) return null;
  tokens.push({ kind: 'name', name: first });
  while (i < s.length) {
    if (s[i] === '.') {
      i++;
      const name = ident();
      if (!name) return null;
      tokens.push({ kind: 'attr', name });
    } else if (s[i] === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) return null;
      const inner = s.slice(i + 1, end).trim();
      i = end + 1;
      if (/^\d+$/.test(inner)) tokens.push({ kind: 'index', index: Number(inner) });
      else if (/^[A-Za-z_][\w]*$/.test(inner)) tokens.push({ kind: 'indexName', name: inner });
      else return null;
    } else if (/\s/.test(s[i])) {
      i++;
    } else {
      return null;
    }
  }
  return tokens;
}

function lookupLocal(frames, name) {
  if (!frames) return null;
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    const hit = f.locals.find(([n]) => n === name);
    if (hit) return { value: hit[1], frame: f.name, frameId: f.id };
  }
  return null;
}

function fieldOf(obj, name) {
  if (!obj || obj.kind !== 'object' || !obj.fields) return undefined;
  const hit = obj.fields.find(([k]) => k === name);
  return hit ? hit[1] : undefined;
}

function indexOf(obj, idx) {
  if (!obj) return undefined;
  if (obj.kind === 'array' || obj.kind === 'set') {
    if (idx < 0 || idx >= obj.items.length) return undefined;
    return obj.items[idx];
  }
  if (obj.kind === 'map') {
    const hit = obj.entries.find(([k]) => k?.t === 'num' && k.v === idx);
    return hit ? hit[1] : undefined;
  }
  return undefined;
}

/**
 * Resolve a watch path against the current step frames + heap.
 * Returns { value, frame, frameId } or null if not resolvable.
 */
export function resolveWatchPath(path, frames, heapMap) {
  const tokens = parseWatchPath(path);
  if (!tokens || !tokens.length) return null;

  const base = lookupLocal(frames, tokens[0].name);
  if (!base) return null;

  let cur = base.value;
  for (let t = 1; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.kind === 'attr') {
      if (!isRefVal(cur) || cur.t !== 'ref') return null;
      const obj = heapMap?.get(cur.id);
      const next = fieldOf(obj, tok.name);
      if (next === undefined) return null;
      cur = next;
    } else if (tok.kind === 'index') {
      if (!isRefVal(cur) || cur.t !== 'ref') return null;
      const obj = heapMap?.get(cur.id);
      const next = indexOf(obj, tok.index);
      if (next === undefined) return null;
      cur = next;
    } else if (tok.kind === 'indexName') {
      const idxLocal = lookupLocal(frames, tok.name);
      const idx = intOf(idxLocal?.value);
      if (idx === null) return null;
      if (!isRefVal(cur) || cur.t !== 'ref') return null;
      const obj = heapMap?.get(cur.id);
      const next = indexOf(obj, idx);
      if (next === undefined) return null;
      cur = next;
    } else {
      return null;
    }
  }
  return { value: cur, frame: base.frame, frameId: base.frameId };
}
