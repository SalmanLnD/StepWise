/**
 * Runtime value model shared by all language interpreters.
 *
 * Primitive JS values circulate directly inside the interpreter:
 *   number, string, boolean, null
 * Compound data lives in the Heap; the interpreter passes around Ref objects.
 * C pointers are Ptr objects (they can also point at stack variables and
 * carry an element offset for pointer arithmetic).
 */

let NEXT_OBJ_ID = 1;

export function resetIds() {
  NEXT_OBJ_ID = 1;
}

export class Ref {
  constructor(id) {
    this.id = id;
  }
}

export class Ptr {
  /** target: { id, offset } for heap or { frameId, name } for stack slots */
  constructor(target) {
    this.target = target;
  }
}

export class CharVal {
  constructor(ch) {
    this.ch = ch;
  }
}

export class FuncVal {
  constructor(name, decl, kind = 'user') {
    this.name = name;
    this.decl = decl;
    this.kind = kind;
  }
}

export class ClassVal {
  constructor(name, decl) {
    this.name = name;
    this.decl = decl;
  }
}

export class RangeVal {
  constructor(start, stop, step) {
    this.start = start;
    this.stop = stop;
    this.step = step;
  }
  toArray() {
    const out = [];
    if (this.step > 0) for (let i = this.start; i < this.stop; i += this.step) out.push(i);
    else for (let i = this.start; i > this.stop; i += this.step) out.push(i);
    return out;
  }
}

export class HeapObject {
  /**
   * kind: 'array' | 'map' | 'set' | 'object'
   * label: display type, e.g. 'list', 'int[]', 'vector<int>', 'Node', 'dict'
   */
  constructor(id, kind, label) {
    this.id = id;
    this.kind = kind;
    this.label = label;
    this.items = kind === 'array' || kind === 'set' ? [] : undefined;
    this.entries = kind === 'map' ? [] : undefined; // [[key, value], ...]
    this.fields = kind === 'object' ? new Map() : undefined;
    this.meta = {}; // language-specific: className, elemType, freed...
  }
}

export class Heap {
  constructor(limits) {
    this.objects = new Map();
    this.limits = limits;
    this.allocCount = 0;
  }

  alloc(kind, label) {
    if (this.objects.size >= this.limits.maxHeapObjects) {
      const err = new Error(`Heap limit exceeded (${this.limits.maxHeapObjects} objects)`);
      err.stepwiseLimit = true;
      throw err;
    }
    const obj = new HeapObject(NEXT_OBJ_ID++, kind, label);
    this.objects.set(obj.id, obj);
    this.allocCount++;
    this.pinHook?.(obj);
    return obj;
  }

  get(id) {
    return this.objects.get(id);
  }

  free(id) {
    this.objects.delete(id);
  }

  deref(ref) {
    const obj = this.objects.get(ref.id);
    return obj ?? null;
  }
}

const NULL_LABELS = {
  python: 'None',
  c: 'NULL',
  cpp: 'nullptr',
  java: 'null',
};

/** Serialize a runtime value into the JSON wire format. */
export function encodeValue(v, language) {
  if (v === null || v === undefined) return { t: 'null', v: NULL_LABELS[language] ?? 'null' };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { t: 'num', v: String(v) };
    return { t: 'num', v };
  }
  if (typeof v === 'boolean') return { t: 'bool', v };
  if (typeof v === 'string') return { t: 'str', v };
  if (v instanceof CharVal) return { t: 'char', v: v.ch };
  if (v instanceof Ref) return { t: 'ref', id: v.id };
  if (v instanceof Ptr) {
    if (v.target == null) return { t: 'null', v: NULL_LABELS[language] ?? 'null' };
    if ('id' in v.target) return { t: 'ref', id: v.target.id, offset: v.target.offset || 0, ptr: true };
    return { t: 'stackref', frame: v.target.frameId, name: v.target.name, ptr: true };
  }
  if (v instanceof FuncVal) return { t: 'func', v: v.name };
  if (v instanceof ClassVal) return { t: 'class', v: v.name };
  if (v instanceof RangeVal) return { t: 'str', v: `range(${v.start}, ${v.stop}${v.step !== 1 ? ', ' + v.step : ''})` };
  return { t: 'str', v: String(v) };
}

export function encodeHeap(heap, language) {
  const out = [];
  for (const obj of heap.objects.values()) {
    const e = { id: obj.id, kind: obj.kind, label: obj.label };
    if (obj.kind === 'array' || obj.kind === 'set') {
      e.items = obj.items.map((x) => encodeValue(x, language));
    } else if (obj.kind === 'map') {
      e.entries = obj.entries.map(([k, val]) => [encodeValue(k, language), encodeValue(val, language)]);
    } else {
      e.fields = [...obj.fields.entries()].map(([k, val]) => [k, encodeValue(val, language)]);
    }
    if (obj.meta.freed) e.freed = true;
    out.push(e);
  }
  return out;
}
