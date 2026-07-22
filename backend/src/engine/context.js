import { Heap, encodeHeap, encodeValue, Ref, Ptr } from './values.js';
import { LimitError, StepwiseError } from './errors.js';

export const DEFAULT_LIMITS = {
  maxSteps: 3000,
  maxOps: 2_000_000,
  maxHeapObjects: 1500,
  maxStdout: 64 * 1024,
  maxCallDepth: 160,
  maxWallMs: 4000,
};

let NEXT_FRAME_ID = 1;

export class Frame {
  constructor(name, callLine = null) {
    this.id = NEXT_FRAME_ID++;
    this.name = name;
    this.callLine = callLine;
    this.line = callLine;
    // scope chain: array of Maps, innermost last (block scoping for C/C++/Java;
    // Python uses a single scope per frame)
    this.scopes = [new Map()];
    this.returned = undefined;
  }

  pushScope() {
    this.scopes.push(new Map());
  }

  popScope() {
    this.scopes.pop();
  }

  lookup(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) return this.scopes[i];
    }
    return null;
  }

  get(name) {
    const s = this.lookup(name);
    return s ? s.get(name) : undefined;
  }

  has(name) {
    return this.lookup(name) !== null;
  }

  declare(name, value) {
    this.scopes[this.scopes.length - 1].set(name, value);
  }

  set(name, value) {
    const s = this.lookup(name);
    if (s) s.set(name, value);
    else this.scopes[this.scopes.length - 1].set(name, value);
  }

  flatVars() {
    const out = new Map();
    for (const scope of this.scopes) {
      for (const [k, v] of scope) out.set(k, v);
    }
    return out;
  }
}

export class ExecContext {
  constructor(language, { stdin = '', limits = {} } = {}) {
    NEXT_FRAME_ID = 1;
    this.language = language;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.heap = new Heap(this.limits);
    this.globalFrame = new Frame(language === 'python' ? 'module' : 'globals');
    this.frames = [this.globalFrame];
    this.stdout = '';
    this.stdinLines = stdin.length ? stdin.split(/\r?\n/) : [];
    this.stdinPos = 0;
    this.stdinTokens = stdin.split(/\s+/).filter(Boolean);
    this.tokenPos = 0;
    this.steps = [];
    // Objects allocated while an expression is still being evaluated are
    // pinned so GC can't sweep values that only live in evaluator locals.
    this.pins = new Set();
    this.tempRoots = []; // stack of value-arrays rooted for loop lifetimes
    this.exprDepth = 0;
    this.heap.pinHook = (obj) => this.pins.add(obj.id);
    this.ops = 0;
    this.startTime = Date.now();
    this.currentLine = null;
    this.truncated = false;
  }

  get frame() {
    return this.frames[this.frames.length - 1];
  }

  pushFrame(name, callLine) {
    if (this.frames.length >= this.limits.maxCallDepth) {
      throw new LimitError(
        `Maximum call depth exceeded (${this.limits.maxCallDepth} frames) — likely infinite recursion`,
        callLine
      );
    }
    const f = new Frame(name, callLine);
    this.frames.push(f);
    return f;
  }

  popFrame() {
    return this.frames.pop();
  }

  tick(line) {
    this.ops++;
    if (this.ops % 512 === 0 && Date.now() - this.startTime > this.limits.maxWallMs) {
      throw new LimitError('Execution time limit exceeded — possible infinite loop', line);
    }
    if (this.ops > this.limits.maxOps) {
      throw new LimitError('Operation limit exceeded — possible infinite loop', line);
    }
  }

  write(text) {
    if (this.stdout.length < this.limits.maxStdout) {
      this.stdout += text;
      if (this.stdout.length >= this.limits.maxStdout) {
        this.stdout = this.stdout.slice(0, this.limits.maxStdout) + '\n… output truncated …\n';
      }
    }
  }

  readLine() {
    if (this.stdinPos < this.stdinLines.length) return this.stdinLines[this.stdinPos++];
    throw new StepwiseError(
      'The program asked for input but stdin ran out — add input lines in the Input panel below the editor.',
      this.currentLine,
      'InputError'
    );
  }

  readToken() {
    if (this.tokenPos < this.stdinTokens.length) return this.stdinTokens[this.tokenPos++];
    throw new StepwiseError(
      'The program asked for input but stdin ran out — add input values in the Input panel below the editor.',
      this.currentLine,
      'InputError'
    );
  }

  hasMoreLines() {
    return this.stdinPos < this.stdinLines.length;
  }

  hasMoreTokens() {
    return this.tokenPos < this.stdinTokens.length;
  }

  /** Mark-and-sweep: drop heap objects unreachable from any frame variable. */
  gc() {
    const marked = new Set();
    const visit = (v) => {
      let id = null;
      if (v instanceof Ref) id = v.id;
      else if (v instanceof Ptr && v.target && 'id' in v.target) id = v.target.id;
      if (id === null || marked.has(id)) return;
      const obj = this.heap.get(id);
      if (!obj) return;
      marked.add(id);
      if (obj.items) obj.items.forEach(visit);
      if (obj.entries) obj.entries.forEach(([k, val]) => (visit(k), visit(val)));
      if (obj.fields) obj.fields.forEach(visit);
    };
    for (const frame of this.frames) {
      for (const scope of frame.scopes) scope.forEach(visit);
    }
    for (const id of this.pins) visit(new Ref(id));
    for (const roots of this.tempRoots) roots.forEach(visit);
    for (const id of [...this.heap.objects.keys()]) {
      if (!marked.has(id)) this.heap.objects.delete(id);
    }
  }

  /**
   * Record an execution step snapshot.
   * event: 'line' | 'call' | 'return' | 'exception'
   */
  step(line, event = 'line', note = '') {
    if (this.truncated) return;
    if (this.steps.length >= this.limits.maxSteps) {
      this.truncated = true;
      return;
    }
    this.currentLine = line;
    this.frame.line = line;
    this.gc();
    const frames = this.frames.map((f) => ({
      id: f.id,
      name: f.name,
      line: f.line,
      callLine: f.callLine,
      locals: [...f.flatVars().entries()].map(([k, v]) => [k, encodeValue(v, this.language)]),
    }));
    this.steps.push({
      i: this.steps.length,
      line,
      event,
      note,
      frames,
      heap: encodeHeap(this.heap, this.language),
      stdout: this.stdout,
    });
  }

  result(error = null) {
    return {
      ok: !error,
      language: this.language,
      steps: this.steps,
      stdout: this.stdout,
      truncated: this.truncated,
      stepCount: this.steps.length,
      allocCount: this.heap.allocCount,
      error: error
        ? { message: error.message, line: error.line ?? this.currentLine, kind: error.kind ?? 'RuntimeError' }
        : null,
    };
  }
}
