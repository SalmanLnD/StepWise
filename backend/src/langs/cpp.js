import { CNormalizer, CInterp, runProgramCLike } from './c.js';
import { Ref, Ptr, CharVal } from '../engine/values.js';
import { ReturnSignal } from '../engine/errors.js';
import { ln, parseType } from './c-shared.js';

const COUT = Symbol('cout');
const CIN = Symbol('cin');

/* ============================ normalizer ============================ */

class CppNormalizer extends CNormalizer {
  topLevel(n) {
    if (n.type === 'class_specifier') return this.structDef(n);
    if (n.type === 'template_declaration') return null;
    if (n.type === 'namespace_definition') {
      const body = n.childForFieldName('body');
      return body ? body.namedChildren.map((c) => this.topLevel(c)).filter(Boolean).flat() : null;
    }
    return super.topLevel(n);
  }

  stmt(n) {
    if (n.type === 'class_specifier') return this.structDef(n);
    if (n.type === 'delete_expression') {
      return {
        type: 'ExprStmt',
        line: ln(n),
        expr: { type: 'Call', line: ln(n), callee: { type: 'Name', line: ln(n), id: 'free' }, args: [this.expr(n.namedChildren[0])] },
      };
    }
    return super.stmt(n);
  }

  funcDef(n) {
    const decl = super.funcDef(n);
    // constructor initializer list:  Node(int v) : val(v), next(nullptr) {}
    const initList = n.children.find((c) => c.type === 'field_initializer_list');
    if (initList) {
      const inits = [];
      for (const fi of initList.namedChildren) {
        if (fi.type !== 'field_initializer') continue;
        const fieldName = fi.namedChildren[0].text;
        const argList = fi.namedChildren.find((c) => c.type === 'argument_list' || c.type === 'initializer_list');
        const argExpr = argList?.namedChildren[0];
        inits.push({
          type: 'Assign',
          line: ln(fi),
          targets: [{
            type: 'Attr',
            line: ln(fi),
            obj: { type: 'Name', line: ln(fi), id: 'this' },
            name: fieldName,
            arrow: true,
          }],
          value: argExpr ? this.expr(argExpr) : { type: 'Null', line: ln(fi) },
          op: null,
        });
      }
      decl.body = [...inits, ...decl.body];
    }
    return decl;
  }

  expr(n) {
    const line = ln(n);
    switch (n.type) {
      case 'new_expression': {
        const t = parseType(n.childForFieldName('type'));
        const args = n.childForFieldName('arguments');
        return {
          type: 'New',
          line,
          ctype: t,
          args: args ? args.namedChildren.map((a) => this.expr(a)) : [],
        };
      }
      case 'delete_expression':
        return {
          type: 'Call',
          line,
          callee: { type: 'Name', line, id: 'free' },
          args: [this.expr(n.namedChildren[0])],
        };
      case 'this':
        return { type: 'Name', line, id: 'this' };
      case 'raw_string_literal':
        return { type: 'Str', line, value: n.text.replace(/^R"\(/, '').replace(/\)"$/, '') };
      case 'user_defined_literal':
        return { type: 'Num', line, value: parseFloat(n.text) };
      default:
        return super.expr(n);
    }
  }
}

/* ============================ evaluator ============================ */

class CppInterp extends CInterp {
  lookupBuiltinName(id) {
    if (id === 'cout' || id === 'cerr') return COUT;
    if (id === 'cin') return CIN;
    if (id === 'endl') return '\n';
    if (id === 'INT_MAX') return 2147483647;
    if (id === 'INT_MIN') return -2147483648;
    if (id === 'this') return null;
    return undefined;
  }

  /** implicit `this->field` inside methods */
  expr_Name(node) {
    const f = this.ctx.frame;
    if (!f.has(node.id) && f.has('this')) {
      const self = f.get('this');
      if (self instanceof Ref) {
        const obj = this.ctx.heap.deref(self);
        if (obj?.fields?.has(node.id)) return obj.fields.get(node.id);
      }
    }
    return super.expr_Name(node);
  }

  assignName(name, value, node) {
    const f = this.ctx.frame;
    if (!f.has(name) && !this.declaredType(name) && f.has('this')) {
      const self = f.get('this');
      if (self instanceof Ref) {
        const obj = this.ctx.heap.deref(self);
        if (obj?.fields?.has(name)) {
          obj.fields.set(name, value);
          return;
        }
      }
    }
    super.assignName(name, value, node);
  }

  /* ---- iostream ---- */

  expr_Bin(node) {
    if (node.op === '<<') {
      const l = this.evalExpr(node.l);
      if (l === COUT) {
        const v = this.evalExpr(node.r);
        this.ctx.write(this.streamStr(v));
        return COUT;
      }
      return this.binop('<<', l, this.evalExpr(node.r), node);
    }
    if (node.op === '>>') {
      const l = this.evalExpr(node.l);
      if (l === CIN) {
        const tok = this.ctx.readToken();
        const t = node.r.type === 'Name' ? this.declaredType(node.r.id) : null;
        let v;
        if (t?.base === 'string' || t?.base === 'char' && t.ptr > 0) v = tok;
        else if (t?.base === 'char') v = new CharVal(tok[0] ?? '\0');
        else if (t?.base === 'float' || t?.base === 'double') v = parseFloat(tok) || 0;
        else v = parseInt(tok, 10) || 0;
        this.assignTo(node.r, v, node);
        return CIN;
      }
      return this.binop('>>', l, this.evalExpr(node.r), node);
    }
    return super.expr_Bin(node);
  }

  streamStr(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (v instanceof CharVal) return v.ch;
    if (typeof v === 'number') return String(v);
    return this.repr(v);
  }

  /* ---- declarations for STL types ---- */

  evalDecl(d, node) {
    const base = d.ctype.base;
    if (d.ctype.ptr === 0) {
      if (base === 'vector') {
        const elem = d.ctype.targs?.[0] ?? { base: 'int', ptr: 0 };
        const label = `vector<${this.typeLabel(elem)}>`;
        const obj = this.ctx.heap.alloc('array', label);
        if (d.init?.type === 'ArrayLit') {
          obj.items = d.init.items.map((x) => this.evalExpr(x));
        } else if (d.init?.type === 'CtorArgs') {
          const n0 = d.init.items[0] ? this.toNum(this.evalExpr(d.init.items[0]), node) : 0;
          const fill = d.init.items[1] ? this.evalExpr(d.init.items[1]) : this.defaultValue(elem);
          for (let i = 0; i < n0; i++) obj.items.push(fill);
        } else if (d.init) {
          return this.evalExpr(d.init);
        }
        obj.meta.elemType = elem;
        return new Ref(obj.id);
      }
      if (base === 'string') {
        if (!d.init) return '';
        if (d.init.type === 'CtorArgs') return d.init.items[0] ? String(this.evalExpr(d.init.items[0])) : '';
        const v = this.evalExpr(d.init);
        return typeof v === 'string' ? v : this.cString(v, node);
      }
      if (base === 'stack' || base === 'queue' || base === 'deque') {
        const obj = this.ctx.heap.alloc('array', base);
        obj.meta.container = base;
        return new Ref(obj.id);
      }
      if (base === 'map' || base === 'unordered_map') {
        const obj = this.ctx.heap.alloc('map', base);
        return new Ref(obj.id);
      }
      if (base === 'set' || base === 'unordered_set') {
        const obj = this.ctx.heap.alloc('set', base);
        return new Ref(obj.id);
      }
      if (base === 'pair') {
        const obj = this.ctx.heap.alloc('object', 'pair');
        obj.fields.set('first', 0);
        obj.fields.set('second', 0);
        return new Ref(obj.id);
      }
      // class instance with constructor args:  Node n(5);
      const sn = this.structNameOf(d.ctype);
      if (sn && d.init?.type === 'CtorArgs') {
        const ref = this.allocStruct(sn);
        this.runConstructor(sn, ref, d.init.items.map((x) => this.evalExpr(x)), node);
        return ref;
      }
    }
    return super.evalDecl(d, node);
  }

  runConstructor(name, ref, args, node) {
    const def = this.structs.get(name);
    const ctor = def?.methods?.find((m) => m.name === name);
    if (ctor) this.callBoundCpp(ctor, ref, args, node, `${name}::${name}`);
  }

  expr_New(node) {
    const sn = this.structNameOf(node.ctype);
    if (sn) {
      const ref = this.allocStruct(sn);
      this.runConstructor(sn, ref, node.args.map((a) => this.evalExpr(a)), node);
      return ref;
    }
    // new int[n]
    const count = node.args[0] ? this.toNum(this.evalExpr(node.args[0]), node) : 1;
    return this.allocArray(node.ctype, [count], null, `${this.typeLabel(node.ctype)}[${count}] (heap)`);
  }

  callBoundCpp(methodDecl, selfRef, args, node, displayName) {
    const frame = this.ctx.pushFrame(displayName, node?.line ?? methodDecl.line);
    try {
      frame.declare('this', selfRef);
      this.bindParams(methodDecl, args, frame, null, node);
      this.ctx.step(methodDecl.bodyLine ?? methodDecl.line, 'call', `${displayName}(${args.map((a) => this.repr(a)).join(', ')})`);
      try {
        this.execBlock(methodDecl.body, false);
      } catch (sig) {
        if (sig instanceof ReturnSignal) return sig.value;
        throw sig;
      }
      this.ctx.step(methodDecl.body[methodDecl.body.length - 1]?.line ?? methodDecl.line, 'return', 'return');
      return null;
    } finally {
      this.ctx.popFrame();
    }
  }

  /* ---- methods on STL containers, strings and user classes ---- */

  expr_Call(node) {
    // strip std:: prefix on free functions
    if (node.callee.type === 'Name' && node.callee.id.startsWith('std::')) {
      const bare = { ...node, callee: { ...node.callee, id: node.callee.id.slice(5) } };
      return super.expr_Call(bare);
    }
    if (node.callee.type === 'Attr') {
      const objAst = node.callee.obj;
      const objVal = this.evalExpr(objAst);
      const args = node.args.map((a) => this.evalExpr(a));
      if (typeof objVal === 'string') {
        const result = this.cppStringMethod(objVal, node.callee.name, args, node);
        if ((node.callee.name === 'push_back' || node.callee.name === 'append') && objAst.type === 'Name') {
          this.assignName(objAst.id, result, node);
          return null;
        }
        return result;
      }
      return this.callMethod(objVal, node.callee.name, args, node);
    }
    return super.expr_Call(node);
  }

  callMethod(objVal, name, args, node) {
    if (typeof objVal === 'string') return this.cppStringMethod(objVal, name, args, node);
    let ref = objVal;
    if (objVal instanceof Ptr) ref = this.readPtr(objVal, node);
    if (ref instanceof Ref) {
      const obj = this.ctx.heap.deref(ref);
      if (obj?.kind === 'object') {
        const def = this.structs.get(obj.meta.className ?? obj.label);
        const m = def?.methods?.find((mm) => mm.name === name);
        if (m) return this.callBoundCpp(m, ref, args, node, `${obj.label}::${name}`);
        throw this.err(`'${obj.label}' has no method '${name}()'`, node);
      }
      if (obj?.kind === 'array') return this.containerMethod(obj, name, args, node);
      if (obj?.kind === 'map') return this.mapMethod(obj, name, args, node);
      if (obj?.kind === 'set') return this.setMethodCpp(obj, name, args, node);
    }
    throw this.err(`Unknown method '.${name}()' on ${this.repr(objVal)}`, node);
  }

  containerMethod(obj, name, args, node) {
    const isQueue = obj.meta.container === 'queue';
    switch (name) {
      case 'begin':
        return new CppIter(obj, 0);
      case 'end':
        return new CppIter(obj, obj.items.length);
      case 'rbegin':
        return new CppIter(obj, obj.items.length - 1, -1);
      case 'rend':
        return new CppIter(obj, -1, -1);
      case 'push_back':
      case 'push':
        obj.items.push(args[0]);
        return null;
      case 'emplace_back':
        obj.items.push(args[0] ?? 0);
        return null;
      case 'pop_back':
        obj.items.pop();
        return null;
      case 'pop':
        if (isQueue) obj.items.shift();
        else obj.items.pop();
        return null;
      case 'push_front':
        obj.items.unshift(args[0]);
        return null;
      case 'pop_front':
        obj.items.shift();
        return null;
      case 'front':
        if (!obj.items.length) throw this.err(`${obj.label} is empty`, node);
        return obj.items[0];
      case 'back':
      case 'top':
        if (!obj.items.length) throw this.err(`${obj.label} is empty`, node);
        return obj.items[obj.items.length - 1];
      case 'size':
      case 'length':
        return obj.items.length;
      case 'empty':
        return obj.items.length === 0;
      case 'clear':
        obj.items.length = 0;
        return null;
      case 'at': {
        const i = this.toNum(args[0], node);
        if (i < 0 || i >= obj.items.length) throw this.err(`vector::at(${i}) out of range (size ${obj.items.length})`, node);
        return obj.items[i];
      }
      case 'resize': {
        const n0 = this.toNum(args[0], node);
        while (obj.items.length < n0) obj.items.push(args[1] ?? 0);
        obj.items.length = n0;
        return null;
      }
      case 'insert':
        obj.items.splice(this.toNum(args[0], node), 0, args[1]);
        return null;
      case 'erase':
        obj.items.splice(this.toNum(args[0], node), 1);
        return null;
      default:
        throw this.err(`Unknown ${obj.label} method '.${name}()'`, node);
    }
  }

  mapMethod(obj, name, args, node) {
    switch (name) {
      case 'count':
        return obj.entries.some(([k]) => this.keyEq(k, args[0])) ? 1 : 0;
      case 'size':
        return obj.entries.length;
      case 'empty':
        return obj.entries.length === 0;
      case 'erase': {
        const i = obj.entries.findIndex(([k]) => this.keyEq(k, args[0]));
        if (i !== -1) obj.entries.splice(i, 1);
        return i !== -1 ? 1 : 0;
      }
      case 'clear':
        obj.entries.length = 0;
        return null;
      case 'insert':
        return null;
      default:
        throw this.err(`Unknown map method '.${name}()'`, node);
    }
  }

  setMethodCpp(obj, name, args, node) {
    switch (name) {
      case 'insert':
        if (!obj.items.some((x) => this.keyEq(x, args[0]))) {
          obj.items.push(args[0]);
          this.sortSet(obj);
        }
        return null;
      case 'count':
        return obj.items.some((x) => this.keyEq(x, args[0])) ? 1 : 0;
      case 'erase': {
        const i = obj.items.findIndex((x) => this.keyEq(x, args[0]));
        if (i !== -1) obj.items.splice(i, 1);
        return i !== -1 ? 1 : 0;
      }
      case 'size':
        return obj.items.length;
      case 'empty':
        return obj.items.length === 0;
      case 'clear':
        obj.items.length = 0;
        return null;
      default:
        throw this.err(`Unknown set method '.${name}()'`, node);
    }
  }

  sortSet(obj) {
    if (obj.label === 'set') {
      obj.items.sort((a, b) => {
        if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : 1;
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        return 0;
      });
    }
  }

  keyEq(a, b) {
    if (a instanceof CharVal && b instanceof CharVal) return a.ch === b.ch;
    return a === b;
  }

  cppStringMethod(s, name, args, node, assignTarget) {
    switch (name) {
      case 'size':
      case 'length':
        return s.length;
      case 'empty':
        return s.length === 0;
      case 'substr': {
        const start = this.toNum(args[0] ?? 0, node);
        const len = args[1] !== undefined ? this.toNum(args[1], node) : undefined;
        return len === undefined ? s.slice(start) : s.slice(start, start + len);
      }
      case 'find': {
        const needle = args[0] instanceof CharVal ? args[0].ch : args[0];
        const i = s.indexOf(needle, args[1] ? this.toNum(args[1], node) : 0);
        return i === -1 ? 4294967295 : i;
      }
      case 'push_back':
      case 'append': {
        const ch = args[0] instanceof CharVal ? args[0].ch : String(args[0]);
        // strings are immutable values — mutate via assignment target if available
        return s + ch;
      }
      case 'at': {
        const i = this.toNum(args[0], node);
        if (i < 0 || i >= s.length) throw this.err(`string::at(${i}) out of range`, node);
        return new CharVal(s[i]);
      }
      case 'c_str':
        return s;
      case 'back':
        return new CharVal(s[s.length - 1] ?? '\0');
      case 'front':
        return new CharVal(s[0] ?? '\0');
      default:
        throw this.err(`Unknown string method '.${name}()'`, node);
    }
  }

  /* ---- string indexing returns char; maps auto-insert like operator[] ---- */

  getIndex(objVal, idx, node) {
    if (objVal instanceof Ref) {
      const obj = this.ctx.heap.deref(objVal);
      if (obj?.kind === 'map') {
        const key = idx instanceof CharVal ? idx : idx;
        const hit = obj.entries.find(([k]) => this.keyEq(k, key));
        if (hit) return hit[1];
        obj.entries.push([key, 0]);
        return 0;
      }
    }
    return super.getIndex(objVal, idx, node);
  }

  setIndex(objVal, idx, value, node) {
    if (objVal instanceof Ref) {
      const obj = this.ctx.heap.deref(objVal);
      if (obj?.kind === 'map') {
        const hit = obj.entries.find(([k]) => this.keyEq(k, idx));
        if (hit) hit[1] = value;
        else obj.entries.push([idx, value]);
        return;
      }
    }
    super.setIndex(objVal, idx, value, node);
  }

  getAttr(objVal, name, node) {
    // pair.first / pair.second on map entries later; strings have no fields
    return super.getAttr(objVal, name, node);
  }

  /* ---- extra builtins ---- */

  callBuiltin(name, args, node) {
    switch (name) {
      case 'max':
        return Math.max(this.toNum(args[0], node), this.toNum(args[1], node));
      case 'min':
        return Math.min(this.toNum(args[0], node), this.toNum(args[1], node));
      case 'swap': {
        // swap(a, b) where a/b are Names — mutate via assignTo if call site kept AST args
        if (node?.args?.length >= 2 && node.args[0].type === 'Name' && node.args[1].type === 'Name') {
          const a = this.evalExpr(node.args[0]);
          const b = this.evalExpr(node.args[1]);
          this.assignTo(node.args[0], b, node);
          this.assignTo(node.args[1], a, node);
          return null;
        }
        throw this.err('std::swap(a, b) needs variable names — use a temp if swapping expressions', node);
      }
      case 'to_string':
        return String(args[0] instanceof CharVal ? args[0].ch : args[0]);
      case 'stoi':
      case 'stol':
        return parseInt(args[0], 10) || 0;
      case 'stod':
      case 'stof':
        return parseFloat(args[0]) || 0;
      case 'getline': {
        // getline(cin, s) — second arg is the string variable
        const line = this.ctx.readLine();
        if (node?.args?.[1]) this.assignTo(node.args[1], line, node);
        return CIN;
      }
      case 'sort':
      case 'reverse':
      case 'find':
      case 'min_element':
      case 'max_element':
        return this.algoFn(name, args, node);
      case 'endl':
        return '\n';
      default:
        return super.callBuiltin(name, args, node);
    }
  }

  algoFn(name, args, node) {
    if (name === 'sort' || name === 'reverse') {
      const range = this.iterRange(args[0], args[1], node);
      const slice = range.obj.items.slice(range.lo, range.hi);
      if (name === 'sort') {
        slice.sort((a, b) => {
          if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
          return this.toNum(a, node) - this.toNum(b, node);
        });
      } else slice.reverse();
      for (let i = 0; i < slice.length; i++) range.obj.items[range.lo + i] = slice[i];
      return null;
    }
    if (name === 'find') {
      const range = this.iterRange(args[0], args[1], node);
      const needle = args[2];
      for (let i = range.lo; i < range.hi; i++) {
        if (this.keyEq(range.obj.items[i], needle)) return new CppIter(range.obj, i);
      }
      return new CppIter(range.obj, range.hi);
    }
    if (name === 'min_element' || name === 'max_element') {
      const range = this.iterRange(args[0], args[1], node);
      if (range.lo >= range.hi) return new CppIter(range.obj, range.hi);
      let best = range.lo;
      for (let i = range.lo + 1; i < range.hi; i++) {
        const cmp = this.toNum(range.obj.items[i], node) - this.toNum(range.obj.items[best], node);
        if (name === 'min_element' ? cmp < 0 : cmp > 0) best = i;
      }
      return new CppIter(range.obj, best);
    }
    return null;
  }

  iterRange(a, b, node) {
    if (a instanceof CppIter && b instanceof CppIter && a.obj === b.obj) {
      return { obj: a.obj, lo: Math.min(a.index, b.index), hi: Math.max(a.index, b.index) };
    }
    // C-style: sort(arr, arr+n) where both are Ptr into same array
    if (a instanceof Ptr && b instanceof Ptr && a.target?.id != null && a.target.id === b.target?.id) {
      const obj = this.ctx.heap.get(a.target.id);
      return { obj, lo: a.target.offset ?? 0, hi: b.target.offset ?? obj.items.length };
    }
    throw this.err(`${node ? '' : ''}algorithm helpers need iterators from the same container (e.g. v.begin(), v.end())`, node);
  }

  repr(v) {
    if (v === null || v === undefined) return 'nullptr';
    if (v === COUT) return 'cout';
    if (v === CIN) return 'cin';
    return super.repr(v);
  }
}

/** Iterator over a heap array (from begin()/end()). */
class CppIter {
  constructor(obj, index, step = 1) {
    this.obj = obj;
    this.index = index;
    this.step = step;
  }
}

/* ============================ entry point ============================ */

export async function runCpp(code, ctx) {
  await runProgramCLike(code, ctx, {
    grammar: 'cpp',
    langName: 'C++',
    InterpClass: CppInterp,
    NormClass: CppNormalizer,
  });
}
