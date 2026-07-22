import { StepwiseError, BREAK, CONTINUE, ReturnSignal } from './errors.js';
import { Ref, Ptr, CharVal, FuncVal, ClassVal, RangeVal } from './values.js';

/**
 * Shared tree-walking evaluator over the common StepWise AST.
 * Language subclasses override the hook methods (binop, callBuiltin,
 * callMethod, getAttr, repr ...) to provide language semantics.
 *
 * Stepping policy: a snapshot is recorded AFTER each simple statement
 * executes (so diffing step k-1 -> k animates the effect of step k's line),
 * plus dedicated 'call' / 'return' snapshots around function frames and a
 * snapshot per loop/branch condition evaluation.
 */
export class Interp {
  constructor(ctx) {
    this.ctx = ctx;
    this.blockScoped = true; // Python subclass sets false
  }

  err(message, node) {
    return new StepwiseError(message, node?.line ?? this.ctx.currentLine);
  }

  /* ---------------- statements ---------------- */

  execBlock(stmts, newScope = true) {
    const scoped = newScope && this.blockScoped;
    if (scoped) this.ctx.frame.pushScope();
    try {
      for (const s of stmts) this.execStmt(s);
    } finally {
      if (scoped) this.ctx.frame.popScope();
    }
  }

  execStmt(node) {
    this.ctx.tick(node.line);
    const m = this['stmt_' + node.type];
    if (!m) throw this.err(`Unsupported statement: ${node.type}`, node);
    return m.call(this, node);
  }

  stmt_ExprStmt(node) {
    const v = this.evalExpr(node.expr);
    let note = '';
    if (node.expr.type === 'Call') note = this.describeCall(node.expr, v);
    else if (node.expr.type === 'Assign' || node.expr.type === 'IncDec') note = this.lastAssignNote || '';
    this.ctx.step(node.line, 'line', note);
  }

  stmt_Pass(node) {
    this.ctx.step(node.line, 'line', 'pass');
  }

  stmt_VarDecl(node) {
    const notes = [];
    for (const d of node.decls) {
      const value = this.evalDeclInit(d, node);
      this.ctx.frame.declare(d.name, value);
      notes.push(`${d.name} = ${this.repr(value)}`);
    }
    this.ctx.step(node.line, 'line', notes.join(', '));
  }

  /** Hook: C/C++/Java override for typed defaults & array dims. */
  evalDeclInit(d, node) {
    return d.init ? this.evalExpr(d.init) : null;
  }

  stmt_Assign(node) {
    const v = this.evalAssign(node);
    this.ctx.step(node.line, 'line', this.lastAssignNote || '');
    return v;
  }

  evalAssign(node) {
    let value;
    if (node.op) {
      const current = this.readTarget(node.targets[0]);
      const rhs = this.evalExpr(node.value);
      value = this.binop(node.op, current, rhs, node);
    } else {
      value = this.evalExpr(node.value);
    }
    for (const t of node.targets) this.assignTo(t, value, node);
    this.lastAssignNote = this.describeAssign(node.targets[0], value);
    return value;
  }

  describeAssign(target, value) {
    return `${this.targetName(target)} = ${this.repr(value)}`;
  }

  targetName(t) {
    switch (t.type) {
      case 'Name':
        return t.id;
      case 'Index':
        return `${this.targetName(t.obj)}[…]`;
      case 'Attr':
        return `${this.targetName(t.obj)}.${t.name}`;
      case 'Unary':
        return t.op === '*' ? `*${this.targetName(t.operand)}` : '…';
      case 'TupleLit':
        return t.items.map((x) => this.targetName(x)).join(', ');
      default:
        return '…';
    }
  }

  readTarget(t) {
    return this.evalExpr(t);
  }

  assignTo(target, value, node) {
    switch (target.type) {
      case 'Name':
        this.assignName(target.id, value, node);
        break;
      case 'Index': {
        const obj = this.evalExpr(target.obj);
        const idx = this.evalExpr(target.index);
        this.setIndex(obj, idx, value, node);
        break;
      }
      case 'Attr': {
        const obj = this.evalExpr(target.obj);
        this.setAttr(obj, target.name, value, node);
        break;
      }
      case 'TupleLit': {
        const vals = this.iterableToArray(value, node);
        if (vals.length !== target.items.length) {
          throw this.err(`Cannot unpack ${vals.length} values into ${target.items.length} targets`, node);
        }
        target.items.forEach((t, i) => this.assignTo(t, vals[i], node));
        break;
      }
      case 'Unary': {
        if (target.op === '*') {
          const ptr = this.evalExpr(target.operand);
          this.writePtr(ptr, value, node);
          break;
        }
        throw this.err(`Invalid assignment target`, node);
      }
      default:
        throw this.err(`Invalid assignment target: ${target.type}`, node);
    }
  }

  assignName(name, value, node) {
    this.ctx.frame.set(name, value);
  }

  writePtr(ptr, value, node) {
    throw this.err('Pointers are not supported in this language', node);
  }

  stmt_If(node) {
    const c = this.truthy(this.evalExpr(node.cond));
    this.ctx.step(node.cond.line ?? node.line, 'line', `if → ${this.reprBool(c)}`);
    if (c) this.execBlock(node.then);
    else if (node.else) {
      if (node.else.length === 1 && node.else[0].type === 'If') this.execStmt(node.else[0]);
      else this.execBlock(node.else);
    }
  }

  stmt_While(node) {
    for (;;) {
      this.ctx.tick(node.line);
      const c = this.truthy(this.evalExpr(node.cond));
      this.ctx.step(node.cond.line ?? node.line, 'line', `while → ${this.reprBool(c)}`);
      if (!c) break;
      try {
        this.execBlock(node.body);
      } catch (sig) {
        if (sig === BREAK) break;
        if (sig !== CONTINUE) throw sig;
      }
    }
  }

  stmt_DoWhile(node) {
    for (;;) {
      this.ctx.tick(node.line);
      try {
        this.execBlock(node.body);
      } catch (sig) {
        if (sig === BREAK) break;
        if (sig !== CONTINUE) throw sig;
      }
      const c = this.truthy(this.evalExpr(node.cond));
      this.ctx.step(node.cond.line ?? node.line, 'line', `do-while → ${this.reprBool(c)}`);
      if (!c) break;
    }
  }

  stmt_ForC(node) {
    const scoped = this.blockScoped;
    if (scoped) this.ctx.frame.pushScope();
    try {
      if (node.init) this.execStmt(node.init);
      for (;;) {
        this.ctx.tick(node.line);
        let c = true;
        if (node.cond) {
          c = this.truthy(this.evalExpr(node.cond));
          this.ctx.step(node.cond.line ?? node.line, 'line', `for → ${this.reprBool(c)}`);
        }
        if (!c) break;
        try {
          this.execBlock(node.body);
        } catch (sig) {
          if (sig === BREAK) break;
          if (sig !== CONTINUE) throw sig;
        }
        if (node.update) this.evalExpr(node.update);
      }
    } finally {
      if (scoped) this.ctx.frame.popScope();
    }
  }

  stmt_ForIn(node) {
    const iterable = this.evalExpr(node.iter);
    const items = this.iterableToArray(iterable, node);
    this.ctx.tempRoots.push(items.flat ? items.flat() : items);
    const scoped = this.blockScoped;
    if (scoped) this.ctx.frame.pushScope();
    try {
      for (const item of items) {
        this.ctx.tick(node.line);
        if (node.targets.length === 1) {
          if (scoped) this.ctx.frame.declare(node.targets[0], item);
          else this.ctx.frame.set(node.targets[0], item);
          this.ctx.step(node.line, 'line', `${node.targets[0]} = ${this.repr(item)}`);
        } else {
          const parts = this.iterableToArray(item, node);
          node.targets.forEach((t, i) => {
            if (scoped) this.ctx.frame.declare(t, parts[i]);
            else this.ctx.frame.set(t, parts[i]);
          });
          this.ctx.step(
            node.line,
            'line',
            node.targets.map((t, i) => `${t} = ${this.repr(parts[i])}`).join(', ')
          );
        }
        try {
          this.execBlock(node.body);
        } catch (sig) {
          if (sig === BREAK) break;
          if (sig !== CONTINUE) throw sig;
        }
      }
    } finally {
      this.ctx.tempRoots.pop();
      if (scoped) this.ctx.frame.popScope();
    }
  }

  stmt_Return(node) {
    const v = node.value ? this.evalExpr(node.value) : null;
    this.ctx.step(node.line, 'return', `return ${node.value ? this.repr(v) : ''}`.trim());
    throw new ReturnSignal(v);
  }

  stmt_Break(node) {
    this.ctx.step(node.line, 'line', 'break');
    throw BREAK;
  }

  stmt_Continue(node) {
    this.ctx.step(node.line, 'line', 'continue');
    throw CONTINUE;
  }

  stmt_Block(node) {
    this.execBlock(node.body);
  }

  stmt_FuncDecl(node) {
    this.ctx.frame.declare(node.name, new FuncVal(node.name, node));
  }

  stmt_ClassDecl(node) {
    this.ctx.frame.declare(node.name, new ClassVal(node.name, node));
  }

  stmt_Throw(node) {
    const v = node.value ? this.evalExpr(node.value) : null;
    throw this.err(`Exception raised: ${this.repr(v)}`, node);
  }

  /* ---------------- expressions ---------------- */

  evalExpr(node) {
    this.ctx.tick(node.line);
    const m = this['expr_' + node.type];
    if (!m) throw this.err(`Unsupported expression: ${node.type}`, node);
    this.ctx.exprDepth++;
    try {
      return m.call(this, node);
    } finally {
      this.ctx.exprDepth--;
      // back at a statement boundary: everything is stored in variables now
      if (this.ctx.exprDepth === 0 && this.ctx.pins.size) this.ctx.pins.clear();
    }
  }

  expr_Num(node) {
    return node.value;
  }
  expr_Str(node) {
    return node.value;
  }
  expr_Char(node) {
    return new CharVal(node.value);
  }
  expr_Bool(node) {
    return node.value;
  }
  expr_Null() {
    return null;
  }

  expr_Name(node) {
    const f = this.ctx.frame;
    if (f.has(node.id)) return f.get(node.id);
    if (f !== this.ctx.globalFrame && this.ctx.globalFrame.has(node.id)) {
      return this.ctx.globalFrame.get(node.id);
    }
    const builtin = this.lookupBuiltinName(node.id);
    if (builtin !== undefined) return builtin;
    throw this.err(`Name '${node.id}' is not defined`, node);
  }

  lookupBuiltinName(id) {
    return undefined;
  }

  expr_Assign(node) {
    return this.evalAssign(node);
  }

  expr_IncDec(node) {
    const old = this.readTarget(node.target);
    const nv = this.binop('+', old, node.delta, node);
    this.assignTo(node.target, nv, node);
    this.lastAssignNote = `${this.targetName(node.target)} = ${this.repr(nv)}`;
    return node.post ? old : nv;
  }

  expr_Bin(node) {
    const l = this.evalExpr(node.l);
    const r = this.evalExpr(node.r);
    return this.binop(node.op, l, r, node);
  }

  expr_Logic(node) {
    const l = this.evalExpr(node.l);
    if (node.op === '&&') {
      if (!this.truthy(l)) return this.logicResult(l, false);
      return this.logicResult(this.evalExpr(node.r), true);
    }
    if (this.truthy(l)) return this.logicResult(l, true);
    return this.logicResult(this.evalExpr(node.r), false);
  }

  /** Python returns the operand; C/Java return a boolean. */
  logicResult(v) {
    return this.truthy(v);
  }

  expr_Unary(node) {
    if (node.op === '&') return this.addrOf(node.operand, node);
    const v = this.evalExpr(node.operand);
    switch (node.op) {
      case '-':
        return -this.toNum(v, node);
      case '+':
        return +this.toNum(v, node);
      case '!':
      case 'not':
        return !this.truthy(v);
      case '~':
        return ~this.toNum(v, node);
      case '*':
        return this.readPtr(v, node);
      default:
        throw this.err(`Unsupported unary operator ${node.op}`, node);
    }
  }

  addrOf(target, node) {
    throw this.err('Address-of is not supported in this language', node);
  }

  readPtr(v, node) {
    throw this.err('Pointer dereference is not supported in this language', node);
  }

  expr_Ternary(node) {
    return this.truthy(this.evalExpr(node.cond)) ? this.evalExpr(node.then) : this.evalExpr(node.else);
  }

  expr_Index(node) {
    const obj = this.evalExpr(node.obj);
    const idx = this.evalExpr(node.index);
    return this.getIndex(obj, idx, node);
  }

  expr_Attr(node) {
    const obj = this.evalExpr(node.obj);
    return this.getAttr(obj, node.name, node);
  }

  expr_Call(node) {
    // method call:  obj.m(args)
    if (node.callee.type === 'Attr') {
      const objVal = this.evalExpr(node.callee.obj);
      const args = node.args.map((a) => this.evalExpr(a));
      return this.callMethod(objVal, node.callee.name, args, node);
    }
    const calleeName = node.callee.type === 'Name' ? node.callee.id : null;
    let fn;
    if (calleeName && !this.ctx.frame.has(calleeName) && !this.ctx.globalFrame.has(calleeName)) {
      const args = node.args.map((a) => this.evalExpr(a));
      return this.callBuiltin(calleeName, args, node);
    }
    fn = this.evalExpr(node.callee);
    const args = node.args.map((a) => this.evalExpr(a));
    if (fn instanceof FuncVal) return this.callFunction(fn, args, node);
    if (fn instanceof ClassVal) return this.instantiate(fn, args, node);
    throw this.err(`'${calleeName ?? this.repr(fn)}' is not callable`, node);
  }

  describeCall(callNode, result) {
    let name = '';
    if (callNode.callee.type === 'Name') name = callNode.callee.id;
    else if (callNode.callee.type === 'Attr') name = `${this.targetName(callNode.callee.obj)}.${callNode.callee.name}`;
    return name ? `${name}(…)` : '';
  }

  /** Call a user function: push frame, bind params, run body. */
  callFunction(fn, args, node, self = null) {
    const decl = fn.decl;
    const callLine = node?.line ?? decl.line;
    const frame = this.ctx.pushFrame(this.frameName(fn, self), callLine);
    try {
      this.bindParams(decl, args, frame, self, node);
      const argsDesc = args.map((a) => this.repr(a)).join(', ');
      this.ctx.step(decl.bodyLine ?? decl.line, 'call', `${frame.name}(${argsDesc})`);
      try {
        this.execBlock(decl.body, false);
      } catch (sig) {
        if (sig instanceof ReturnSignal) return sig.value;
        throw sig;
      }
      this.implicitReturnStep(decl);
      return null;
    } finally {
      this.ctx.popFrame();
    }
  }

  implicitReturnStep(decl) {
    const last = decl.body[decl.body.length - 1];
    this.ctx.step(last?.line ?? decl.line, 'return', 'return');
  }

  frameName(fn, self) {
    return fn.name;
  }

  bindParams(decl, args, frame, self, node) {
    const params = decl.params;
    for (let i = 0; i < params.length; i++) {
      let v = args[i];
      if (v === undefined) {
        if (params[i].default !== undefined && params[i].default !== null) {
          v = this.evalExprInFrame(params[i].default);
        } else {
          throw this.err(`Missing argument '${params[i].name}' for ${decl.name}()`, node);
        }
      }
      frame.declare(params[i].name, v);
    }
    if (args.length > params.length) {
      throw this.err(`${decl.name}() takes ${params.length} arguments but ${args.length} were given`, node);
    }
  }

  evalExprInFrame(expr) {
    return this.evalExpr(expr);
  }

  instantiate(cls, args, node) {
    throw this.err(`Cannot instantiate ${cls.name} in this language`, node);
  }

  /* ---------------- hooks every language must provide ---------------- */

  binop(op, l, r, node) {
    throw this.err(`Unsupported operator ${op}`, node);
  }

  truthy(v) {
    if (v === null || v === undefined) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v.length > 0;
    if (v instanceof CharVal) return v.ch.charCodeAt(0) !== 0;
    if (v instanceof Ptr) return v.target != null;
    return true;
  }

  reprBool(b) {
    return String(b);
  }

  toNum(v, node) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof CharVal) return v.ch.charCodeAt(0);
    throw this.err(`Expected a number, got ${this.repr(v)}`, node);
  }

  callBuiltin(name, args, node) {
    throw this.err(`Unknown function '${name}'`, node);
  }

  callMethod(objVal, name, args, node) {
    throw this.err(`Unknown method '.${name}()'`, node);
  }

  getAttr(objVal, name, node) {
    throw this.err(`Cannot read attribute '${name}'`, node);
  }

  setAttr(objVal, name, value, node) {
    throw this.err(`Cannot set attribute '${name}'`, node);
  }

  getIndex(objVal, idx, node) {
    const obj = this.derefArray(objVal, node);
    const i = this.normIndex(obj, idx, node);
    return obj.items[i];
  }

  setIndex(objVal, idx, value, node) {
    const obj = this.derefArray(objVal, node);
    const i = this.normIndex(obj, idx, node);
    obj.items[i] = value;
  }

  derefArray(objVal, node) {
    if (objVal instanceof Ref) {
      const obj = this.ctx.heap.deref(objVal);
      if (obj) return obj;
    }
    throw this.err(`Value ${this.repr(objVal)} is not indexable`, node);
  }

  normIndex(obj, idx, node) {
    let i = this.toNum(idx, node);
    if (i < 0) i += obj.items.length;
    if (!Number.isInteger(i) || i < 0 || i >= obj.items.length) {
      throw this.err(`Index ${this.repr(idx)} out of range (size ${obj.items.length})`, node);
    }
    return i;
  }

  iterableToArray(v, node) {
    if (Array.isArray(v)) return v;
    if (v instanceof RangeVal) return v.toArray();
    if (typeof v === 'string') return [...v];
    if (v instanceof Ref) {
      const obj = this.ctx.heap.deref(v);
      if (obj) {
        if (obj.kind === 'array' || obj.kind === 'set') return [...obj.items];
        if (obj.kind === 'map') return obj.entries.map(([k]) => k);
      }
    }
    throw this.err(`Value ${this.repr(v)} is not iterable`, node);
  }

  repr(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (v instanceof CharVal) return `'${v.ch}'`;
    if (v instanceof FuncVal) return `<function ${v.name}>`;
    if (v instanceof ClassVal) return `<class ${v.name}>`;
    if (v instanceof RangeVal) return `range(${v.start}, ${v.stop})`;
    if (v instanceof Ptr) {
      if (v.target == null) return 'null';
      return 'ptr';
    }
    if (v instanceof Ref) {
      const obj = this.ctx.heap.deref(v);
      if (!obj) return 'ref';
      return this.reprObject(obj, 2);
    }
    return String(v);
  }

  reprObject(obj, depth) {
    if (depth <= 0) return obj.label;
    const inner = (x) => {
      if (x instanceof Ref) {
        const o = this.ctx.heap.deref(x);
        return o ? this.reprObject(o, depth - 1) : 'ref';
      }
      return this.repr(x);
    };
    if (obj.kind === 'array') {
      const s = obj.items.slice(0, 12).map(inner).join(', ');
      return `[${s}${obj.items.length > 12 ? ', …' : ''}]`;
    }
    if (obj.kind === 'set') {
      return `{${obj.items.slice(0, 12).map(inner).join(', ')}}`;
    }
    if (obj.kind === 'map') {
      const s = obj.entries
        .slice(0, 8)
        .map(([k, v]) => `${inner(k)}: ${inner(v)}`)
        .join(', ');
      return `{${s}${obj.entries.length > 8 ? ', …' : ''}}`;
    }
    return obj.label;
  }
}
