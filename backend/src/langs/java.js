import { Interp } from '../engine/interp-base.js';
import { ParseError, ReturnSignal, StepwiseError } from '../engine/errors.js';
import { Ref, CharVal, FuncVal } from '../engine/values.js';
import { getParser, findSyntaxError } from '../engine/parser-host.js';

const ln = (n) => n.startPosition.row + 1;

function unescapeJava(raw) {
  let s = raw;
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1);
  return s.replace(/\\(n|t|r|\\|'|")/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c));
}

const INT_TYPES = new Set(['int', 'long', 'short', 'byte']);

/* ============================ CST -> AST ============================ */

class JavaNormalizer {
  program(root) {
    this.classes = [];
    for (const c of root.namedChildren) {
      if (c.type === 'class_declaration') this.classes.push(this.classDecl(c));
      else if (c.type === 'import_declaration' || c.type === 'comment' || c.type === 'package_declaration') continue;
      else throw new ParseError(`Unsupported top-level Java construct: ${c.type.replace(/_/g, ' ')}`, ln(c));
    }
    return { type: 'Program', line: 1, classes: this.classes };
  }

  classDecl(n) {
    const name = n.childForFieldName('name').text;
    const body = n.childForFieldName('body');
    const fields = [];
    const methods = [];
    for (const m of body.namedChildren) {
      if (m.type === 'method_declaration' || m.type === 'constructor_declaration') {
        methods.push(this.methodDecl(m, name));
      } else if (m.type === 'class_declaration') {
        this.classes.push(this.classDecl(m)); // nested (static) class → hoist to top level
      } else if (m.type === 'field_declaration') {
        const isStatic = m.children.some((c) => c.type === 'modifiers' && c.text.includes('static'));
        const jtype = this.typeOf(m.childForFieldName('type'));
        for (const d of m.namedChildren) {
          if (d.type !== 'variable_declarator') continue;
          fields.push({
            name: d.childForFieldName('name').text,
            jtype,
            static: isStatic,
            init: d.childForFieldName('value') ? this.expr(d.childForFieldName('value')) : null,
            line: ln(d),
          });
        }
      }
    }
    return { type: 'ClassDecl', line: ln(n), name, fields, methods };
  }

  methodDecl(n, className) {
    const isCtor = n.type === 'constructor_declaration';
    const name = isCtor ? className : n.childForFieldName('name').text;
    const isStatic = isCtor ? false : n.children.some((c) => c.type === 'modifiers' && c.text.includes('static'));
    const params = [];
    for (const p of n.childForFieldName('parameters').namedChildren) {
      if (p.type !== 'formal_parameter') continue;
      params.push({ name: p.childForFieldName('name').text, jtype: this.typeOf(p.childForFieldName('type')) });
    }
    const bodyNode = n.childForFieldName('body');
    const body = bodyNode ? this.blockBody(bodyNode) : [];
    return {
      type: 'FuncDecl',
      line: ln(n),
      name,
      params,
      body,
      isStatic,
      isCtor,
      bodyLine: bodyNode?.namedChildren[0] ? ln(bodyNode.namedChildren[0]) : ln(n),
    };
  }

  typeOf(n) {
    if (!n) return 'void';
    if (n.type === 'generic_type') return n.namedChildren[0].text;
    if (n.type === 'array_type') return this.typeOf(n.childForFieldName('element')) + '[]';
    return n.text;
  }

  blockBody(n) {
    const out = [];
    for (const c of n.namedChildren) {
      if (c.type === 'comment') continue;
      const s = this.stmt(c);
      if (s) out.push(s);
    }
    return out;
  }

  stmt(n) {
    const line = ln(n);
    switch (n.type) {
      case 'block':
        return { type: 'Block', line, body: this.blockBody(n) };
      case 'expression_statement':
        return { type: 'ExprStmt', line, expr: this.expr(n.namedChildren[0]) };
      case 'local_variable_declaration': {
        const jtype = this.typeOf(n.childForFieldName('type'));
        const decls = [];
        for (const d of n.namedChildren) {
          if (d.type !== 'variable_declarator') continue;
          const dims = d.children.filter((c) => c.text === '[]').length;
          decls.push({
            name: d.childForFieldName('name').text,
            jtype: jtype + '[]'.repeat(dims),
            init: d.childForFieldName('value') ? this.expr(d.childForFieldName('value')) : null,
          });
        }
        return { type: 'VarDecl', line, decls };
      }
      case 'if_statement': {
        const wrap = (s) => {
          if (!s) return null;
          const st = this.stmt(s);
          if (!st) return [];
          return st.type === 'Block' ? st.body : [st];
        };
        return {
          type: 'If',
          line,
          cond: this.expr(n.childForFieldName('condition').namedChildren[0]),
          then: wrap(n.childForFieldName('consequence')),
          else: wrap(n.childForFieldName('alternative')),
        };
      }
      case 'while_statement': {
        const b = this.stmt(n.childForFieldName('body'));
        return {
          type: 'While',
          line,
          cond: this.expr(n.childForFieldName('condition').namedChildren[0]),
          body: b?.type === 'Block' ? b.body : b ? [b] : [],
        };
      }
      case 'do_statement': {
        const b = this.stmt(n.childForFieldName('body'));
        return {
          type: 'DoWhile',
          line,
          cond: this.expr(n.childForFieldName('condition').namedChildren[0]),
          body: b?.type === 'Block' ? b.body : b ? [b] : [],
        };
      }
      case 'for_statement': {
        const initN = n.childForFieldName('init');
        const condN = n.childForFieldName('condition');
        const updN = n.childForFieldName('update');
        const b = this.stmt(n.childForFieldName('body'));
        return {
          type: 'ForC',
          line,
          init: initN
            ? initN.type === 'local_variable_declaration'
              ? this.stmt(initN)
              : { type: 'ExprStmt', line: ln(initN), expr: this.expr(initN) }
            : null,
          cond: condN ? this.expr(condN) : null,
          update: updN ? this.expr(updN) : null,
          body: b?.type === 'Block' ? b.body : b ? [b] : [],
        };
      }
      case 'enhanced_for_statement': {
        const b = this.stmt(n.childForFieldName('body'));
        return {
          type: 'ForIn',
          line,
          targets: [n.childForFieldName('name').text],
          iter: this.expr(n.childForFieldName('value')),
          body: b?.type === 'Block' ? b.body : b ? [b] : [],
        };
      }
      case 'return_statement': {
        const v = n.namedChildren[0];
        return { type: 'Return', line, value: v ? this.expr(v) : null };
      }
      case 'break_statement':
        return { type: 'Break', line };
      case 'continue_statement':
        return { type: 'Continue', line };
      case 'throw_statement':
        return { type: 'Throw', line, value: n.namedChildren[0] ? this.expr(n.namedChildren[0]) : null };
      case 'comment':
        return null;
      default:
        throw new ParseError(`Unsupported Java statement: ${n.type.replace(/_/g, ' ')}`, line);
    }
  }

  expr(n) {
    const line = ln(n);
    switch (n.type) {
      case 'decimal_integer_literal':
      case 'hex_integer_literal':
      case 'binary_integer_literal':
        return { type: 'Num', line, value: parseInt(n.text.replace(/[lL]$/, ''), n.text.match(/^0[xX]/) ? 16 : n.text.match(/^0[bB]/) ? 2 : 10) };
      case 'decimal_floating_point_literal':
        return { type: 'Num', line, value: parseFloat(n.text), isFloat: true };
      case 'string_literal':
        return { type: 'Str', line, value: unescapeJava(n.text) };
      case 'character_literal':
        return { type: 'Char', line, value: unescapeJava(n.text) };
      case 'true':
        return { type: 'Bool', line, value: true };
      case 'false':
        return { type: 'Bool', line, value: false };
      case 'null_literal':
        return { type: 'Null', line };
      case 'identifier':
        return { type: 'Name', line, id: n.text };
      case 'this':
        return { type: 'Name', line, id: 'this' };
      case 'binary_expression': {
        const op = n.childForFieldName('operator').text;
        const l = this.expr(n.childForFieldName('left'));
        const r = this.expr(n.childForFieldName('right'));
        if (op === '&&' || op === '||') return { type: 'Logic', line, op, l, r };
        return { type: 'Bin', line, op, l, r };
      }
      case 'unary_expression':
        return { type: 'Unary', line, op: n.childForFieldName('operator').text, operand: this.expr(n.childForFieldName('operand')) };
      case 'update_expression': {
        const inner = n.namedChildren[0];
        const post = n.firstChild.startIndex === inner.startIndex;
        const delta = n.text.includes('++') ? 1 : -1;
        return { type: 'IncDec', line, target: this.expr(inner), delta, post };
      }
      case 'assignment_expression': {
        const opText = n.childForFieldName('operator').text;
        return {
          type: 'Assign',
          line,
          targets: [this.expr(n.childForFieldName('left'))],
          value: this.expr(n.childForFieldName('right')),
          op: opText === '=' ? null : opText.slice(0, -1),
        };
      }
      case 'ternary_expression':
        return {
          type: 'Ternary',
          line,
          cond: this.expr(n.childForFieldName('condition')),
          then: this.expr(n.childForFieldName('consequence')),
          else: this.expr(n.childForFieldName('alternative')),
        };
      case 'parenthesized_expression':
        return this.expr(n.namedChildren[0]);
      case 'cast_expression': {
        const t = this.typeOf(n.childForFieldName('type'));
        return { type: 'JCast', line, jtype: t, expr: this.expr(n.childForFieldName('value')) };
      }
      case 'array_access':
        return {
          type: 'Index',
          line,
          obj: this.expr(n.childForFieldName('array')),
          index: this.expr(n.childForFieldName('index')),
        };
      case 'field_access': {
        const objN = n.childForFieldName('object');
        const field = n.childForFieldName('field').text;
        const path = objN.text + '.' + field;
        if (path === 'Integer.MAX_VALUE') return { type: 'Num', line, value: 2147483647 };
        if (path === 'Integer.MIN_VALUE') return { type: 'Num', line, value: -2147483648 };
        if (path === 'Math.PI') return { type: 'Num', line, value: Math.PI };
        if (path === 'System.in' || path === 'System.out' || path === 'System.err') {
          return { type: 'Null', line }; // stdin/stdout handled by Scanner / System.out.* builtins
        }
        return { type: 'Attr', line, obj: this.expr(objN), name: field };
      }
      case 'method_invocation': {
        const objN = n.childForFieldName('object');
        const name = n.childForFieldName('name').text;
        const args = n.childForFieldName('arguments').namedChildren
          .filter((a) => a.type !== 'comment')
          .map((a) => this.expr(a));
        if (objN) {
          const objText = objN.text;
          if (objText === 'System.out') {
            return { type: 'Call', line, callee: { type: 'Name', line, id: '__' + name }, args };
          }
          if (
            objText === 'Math' ||
            objText === 'Integer' ||
            objText === 'Long' ||
            objText === 'Double' ||
            objText === 'String' ||
            objText === 'Arrays' ||
            objText === 'Collections' ||
            objText === 'Character'
          ) {
            return { type: 'Call', line, callee: { type: 'Name', line, id: objText + '.' + name }, args };
          }
          return { type: 'Call', line, callee: { type: 'Attr', line, obj: this.expr(objN), name }, args };
        }
        return { type: 'Call', line, callee: { type: 'Name', line, id: name }, args };
      }
      case 'object_creation_expression': {
        const t = this.typeOf(n.childForFieldName('type'));
        const args = n.childForFieldName('arguments').namedChildren.map((a) => this.expr(a));
        return { type: 'New', line, jtype: t, args };
      }
      case 'array_creation_expression': {
        const t = this.typeOf(n.childForFieldName('type'));
        const dims = [];
        for (const c of n.children) {
          if (c.type === 'dimensions_expr') dims.push(this.expr(c.namedChildren[0]));
        }
        const valueN = n.childForFieldName('value');
        return {
          type: 'NewArray',
          line,
          jtype: t,
          dims,
          init: valueN ? this.arrayInit(valueN) : null,
        };
      }
      case 'array_initializer':
        return this.arrayInit(n);
      default:
        throw new ParseError(`Unsupported Java expression: ${n.type.replace(/_/g, ' ')}`, line);
    }
  }

  arrayInit(n) {
    return {
      type: 'ArrayLit',
      line: ln(n),
      items: n.namedChildren.map((c) => (c.type === 'array_initializer' ? this.arrayInit(c) : this.expr(c))),
    };
  }
}

/* ============================ evaluator ============================ */

class JavaInterp extends Interp {
  constructor(ctx) {
    super(ctx);
    this.classes = new Map();
  }

  reprBool(b) {
    return String(b);
  }

  javaStr(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return v;
    if (v instanceof CharVal) return v.ch;
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
    if (v instanceof Ref) {
      const obj = this.ctx.heap.deref(v);
      if (!obj) return 'null';
      if (obj.kind === 'array') {
        if (obj.label === 'ArrayList' || obj.label.endsWith('List') || obj.label === 'Stack' || obj.label === 'PriorityQueue' || obj.label === 'ArrayDeque') {
          return `[${obj.items.map((x) => this.javaStr(x)).join(', ')}]`;
        }
        return `${obj.label}@${obj.id.toString(16)}`;
      }
      if (obj.kind === 'map') {
        return `{${obj.entries.map(([k, val]) => `${this.javaStr(k)}=${this.javaStr(val)}`).join(', ')}}`;
      }
      return `${obj.label}@${obj.id.toString(16)}`;
    }
    return String(v);
  }

  repr(v) {
    if (typeof v === 'string') return `"${v}"`;
    if (v === null || v === undefined) return 'null';
    if (v instanceof CharVal) return `'${v.ch}'`;
    if (v instanceof Ref) {
      const obj = this.ctx.heap.deref(v);
      if (obj?.kind === 'object') return `${obj.label}@${obj.id.toString(16)}`;
    }
    return super.repr(v);
  }

  keyEq(a, b) {
    if (a instanceof CharVal && b instanceof CharVal) return a.ch === b.ch;
    return a === b;
  }

  binop(op, l, r, node) {
    if (op === '+' && (typeof l === 'string' || typeof r === 'string')) {
      return this.javaStr(l) + this.javaStr(r);
    }
    if (op === '==' || op === '!=') {
      let eq;
      if (l instanceof Ref && r instanceof Ref) eq = l.id === r.id;
      else if (l === null || r === null) eq = (l ?? null) === (r ?? null);
      else if (l instanceof CharVal || r instanceof CharVal) eq = this.toNum(l, node) === this.toNum(r, node);
      else if (typeof l === 'string' && typeof r === 'string') eq = l === r; // interned-literal behaviour
      else eq = l === r;
      return op === '==' ? eq : !eq;
    }
    const a = this.toNum(l, node);
    const b = this.toNum(r, node);
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        if (b === 0 && Number.isInteger(a) && Number.isInteger(b)) {
          throw this.err('ArithmeticException: / by zero', node);
        }
        return Number.isInteger(a) && Number.isInteger(b) ? Math.trunc(a / b) : a / b;
      case '%':
        if (b === 0) throw this.err('ArithmeticException: / by zero', node);
        return a % b;
      case '<':
        return a < b;
      case '<=':
        return a <= b;
      case '>':
        return a > b;
      case '>=':
        return a >= b;
      case '&':
        return a & b;
      case '|':
        return a | b;
      case '^':
        return a ^ b;
      case '<<':
        return a << b;
      case '>>':
        return a >> b;
      case '>>>':
        return a >>> b;
      default:
        throw this.err(`Unsupported operator ${op}`, node);
    }
  }

  expr_JCast(node) {
    const v = this.evalExpr(node.expr);
    if (INT_TYPES.has(node.jtype)) return Math.trunc(this.toNum(v, node));
    if (node.jtype === 'char') return new CharVal(String.fromCharCode(this.toNum(v, node)));
    if (node.jtype === 'double' || node.jtype === 'float') return this.toNum(v, node);
    return v;
  }

  /* ---- declarations ---- */

  defaultFor(jtype) {
    if (INT_TYPES.has(jtype) || jtype === 'double' || jtype === 'float') return 0;
    if (jtype === 'boolean') return false;
    if (jtype === 'char') return new CharVal('\0');
    return null;
  }

  stmt_VarDecl(node) {
    const notes = [];
    for (const d of node.decls) {
      let v;
      if (d.init) {
        if (d.init.type === 'ArrayLit') {
          v = this.buildArrayFromLit(d.init, d.jtype);
        } else {
          v = this.evalExpr(d.init);
          if (INT_TYPES.has(d.jtype) && typeof v === 'number') v = Math.trunc(v);
        }
      } else {
        v = this.defaultFor(d.jtype);
      }
      this.ctx.frame.declare(d.name, v);
      notes.push(`${d.name} = ${this.repr(v)}`);
    }
    this.ctx.step(node.line, 'line', notes.join(', '));
  }

  buildArrayFromLit(lit, jtype) {
    const elemType = jtype?.endsWith('[]') ? jtype.slice(0, -2) : 'int';
    const obj = this.ctx.heap.alloc('array', `${elemType}[${lit.items.length}]`);
    obj.items = lit.items.map((x) =>
      x.type === 'ArrayLit' ? this.buildArrayFromLit(x, elemType) : this.evalExpr(x)
    );
    return new Ref(obj.id);
  }

  expr_ArrayLit(node) {
    return this.buildArrayFromLit(node, 'int[]');
  }

  expr_NewArray(node) {
    const dims = node.dims.map((d) => this.toNum(this.evalExpr(d), node));
    if (node.init) return this.buildArrayFromLit(node.init, node.jtype + '[]');
    const build = (ds, depth) => {
      const obj = this.ctx.heap.alloc('array', `${node.jtype}${'[]'.repeat(Math.max(0, ds.length - 1))}[${ds[0]}]`);
      for (let i = 0; i < ds[0]; i++) {
        obj.items.push(ds.length > 1 ? build(ds.slice(1), depth + 1) : this.defaultFor(node.jtype));
      }
      return new Ref(obj.id);
    };
    return build(dims, 0);
  }

  expr_New(node) {
    const t = node.jtype;
    if (t === 'Scanner') {
      const obj = this.ctx.heap.alloc('object', 'Scanner');
      obj.meta.scanner = true;
      return new Ref(obj.id);
    }
    if (t === 'ArrayList' || t === 'LinkedList' || t === 'Stack' || t === 'ArrayDeque' || t === 'PriorityQueue') {
      const obj = this.ctx.heap.alloc('array', t);
      obj.meta.container = t;
      return new Ref(obj.id);
    }
    if (t === 'HashMap' || t === 'TreeMap' || t === 'LinkedHashMap') {
      const obj = this.ctx.heap.alloc('map', t);
      return new Ref(obj.id);
    }
    if (t === 'HashSet' || t === 'TreeSet') {
      const obj = this.ctx.heap.alloc('set', t);
      return new Ref(obj.id);
    }
    if (t === 'StringBuilder') {
      const obj = this.ctx.heap.alloc('object', 'StringBuilder');
      obj.fields.set('value', node.args[0] ? this.javaStr(this.evalExpr(node.args[0])) : '');
      return new Ref(obj.id);
    }
    if (t === 'String') return node.args[0] ? this.javaStr(this.evalExpr(node.args[0])) : '';
    const cls = this.classes.get(t);
    if (!cls) throw this.err(`Unknown class '${t}'`, node);
    const obj = this.ctx.heap.alloc('object', t);
    obj.meta.className = t;
    for (const f of cls.fields) {
      if (!f.static) obj.fields.set(f.name, f.init ? this.evalExpr(f.init) : this.defaultFor(f.jtype));
    }
    const ref = new Ref(obj.id);
    const ctor = cls.methods.find((m) => m.isCtor);
    if (ctor) {
      const args = node.args.map((a) => this.evalExpr(a));
      this.callJavaMethod(ctor, ref, args, node, `new ${t}`);
    }
    return ref;
  }

  /* ---- attribute access ---- */

  getAttr(objVal, name, node) {
    if (objVal instanceof Ref) {
      const obj = this.ctx.heap.deref(objVal);
      if (obj?.kind === 'array' && name === 'length') return obj.items.length;
      if (obj?.kind === 'object') {
        if (obj.fields.has(name)) return obj.fields.get(name);
        throw this.err(`'${obj.label}' has no field '${name}'`, node);
      }
    }
    if (typeof objVal === 'string' && name === 'length') return objVal.length;
    if (objVal === null) throw this.err(`NullPointerException: reading '${name}' of null`, node);
    throw this.err(`Cannot read field '${name}' of ${this.repr(objVal)}`, node);
  }

  setAttr(objVal, name, value, node) {
    if (objVal instanceof Ref) {
      const obj = this.ctx.heap.deref(objVal);
      if (obj?.kind === 'object') {
        obj.fields.set(name, value);
        return;
      }
    }
    if (objVal === null) throw this.err(`NullPointerException: setting '${name}' on null`, node);
    throw this.err(`Cannot set field '${name}' on ${this.repr(objVal)}`, node);
  }

  /** implicit this.field inside instance methods */
  expr_Name(node) {
    const f = this.ctx.frame;
    if (node.id === 'this') {
      if (f.has('this')) return f.get('this');
      throw this.err(`'this' used outside an instance method`, node);
    }
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
    if (!f.has(name) && f.has('this')) {
      const self = f.get('this');
      if (self instanceof Ref) {
        const obj = this.ctx.heap.deref(self);
        if (obj?.fields?.has(name)) {
          obj.fields.set(name, value);
          return;
        }
      }
    }
    if (!f.has(name) && this.ctx.globalFrame.has(name)) {
      this.ctx.globalFrame.set(name, value);
      return;
    }
    super.assignName(name, value, node);
  }

  /* ---- calls ---- */

  expr_Call(node) {
    // static call on a user class:  Helper.doIt(x)
    if (node.callee.type === 'Attr' && node.callee.obj.type === 'Name' && this.classes.has(node.callee.obj.id)) {
      const cls = this.classes.get(node.callee.obj.id);
      const m = cls.methods.find((mm) => mm.name === node.callee.name && mm.isStatic);
      if (m) {
        const args = node.args.map((a) => this.evalExpr(a));
        return this.callJavaMethod(m, null, args, node, `${cls.name}.${m.name}`);
      }
    }
    return super.expr_Call(node);
  }

  callMethod(objVal, name, args, node) {
    if (objVal === null) throw this.err(`NullPointerException: calling '${name}()' on null`, node);
    if (typeof objVal === 'string') return this.stringMethod(objVal, name, args, node);
    if (objVal instanceof Ref) {
      const obj = this.ctx.heap.deref(objVal);
      if (obj?.kind === 'object') {
        if (obj.meta?.scanner || obj.label === 'Scanner') return this.scannerMethod(name, args, node);
        if (obj.label === 'StringBuilder') return this.sbMethod(obj, name, args, node);
        const cls = this.classes.get(obj.meta.className);
        const m = cls?.methods.find((mm) => mm.name === name && !mm.isCtor);
        if (m) return this.callJavaMethod(m, objVal, args, node, `${obj.label}.${name}`);
        throw this.err(`'${obj.label}' has no method '${name}()'`, node);
      }
      if (obj?.kind === 'array') return this.listMethod(obj, name, args, node);
      if (obj?.kind === 'map') return this.mapMethod(obj, name, args, node);
      if (obj?.kind === 'set') return this.setMethod(obj, name, args, node);
    }
    throw this.err(`Unknown method '.${name}()' on ${this.repr(objVal)}`, node);
  }

  callJavaMethod(decl, selfRef, args, node, displayName) {
    const frame = this.ctx.pushFrame(displayName, node?.line ?? decl.line);
    try {
      if (selfRef) frame.declare('this', selfRef);
      for (let i = 0; i < decl.params.length; i++) {
        if (args[i] === undefined) throw this.err(`Missing argument '${decl.params[i].name}'`, node);
        frame.declare(decl.params[i].name, args[i]);
      }
      this.ctx.step(decl.bodyLine ?? decl.line, 'call', `${displayName}(${args.map((a) => this.repr(a)).join(', ')})`);
      try {
        this.execBlock(decl.body, false);
      } catch (sig) {
        if (sig instanceof ReturnSignal) return sig.value;
        throw sig;
      }
      this.ctx.step(decl.body[decl.body.length - 1]?.line ?? decl.line, 'return', 'return');
      return null;
    } finally {
      this.ctx.popFrame();
    }
  }

  callFunction(fn, args, node) {
    // same-class method call by bare name
    if (fn.decl?.type === 'FuncDecl' && fn.decl.isStatic !== undefined) {
      const self = this.ctx.frame.has('this') ? this.ctx.frame.get('this') : null;
      return this.callJavaMethod(fn.decl, fn.decl.isStatic ? null : self, args, node, fn.name);
    }
    return super.callFunction(fn, args, node);
  }

  /* ---- built-in library methods ---- */

  listMethod(obj, name, args, node) {
    const c = obj.meta.container ?? 'ArrayList';
    switch (name) {
      case 'add':
      case 'offer':
      case 'addLast':
        if (name === 'add' && args.length === 2 && typeof args[0] === 'number' && c === 'ArrayList') {
          obj.items.splice(this.toNum(args[0], node), 0, args[1]);
        } else {
          obj.items.push(args.length === 2 ? args[1] : args[0]);
          if (c === 'PriorityQueue') obj.items.sort((x, y) => this.toNum(x, node) - this.toNum(y, node));
        }
        return true;
      case 'push':
        if (c === 'ArrayDeque' || c === 'LinkedList') obj.items.unshift(args[0]);
        else obj.items.push(args[0]);
        return args[0];
      case 'addFirst':
        obj.items.unshift(args[0]);
        return null;
      case 'get': {
        const i = this.toNum(args[0], node);
        if (i < 0 || i >= obj.items.length) {
          throw this.err(`IndexOutOfBoundsException: index ${i}, size ${obj.items.length}`, node);
        }
        return obj.items[i];
      }
      case 'set': {
        const i = this.toNum(args[0], node);
        const old = obj.items[i];
        obj.items[i] = args[1];
        return old;
      }
      case 'remove': {
        if (c === 'ArrayList' && typeof args[0] === 'number') {
          const i = this.toNum(args[0], node);
          if (i < 0 || i >= obj.items.length) {
            throw this.err(`IndexOutOfBoundsException: index ${i}, size ${obj.items.length}`, node);
          }
          return obj.items.splice(i, 1)[0];
        }
        return obj.items.shift();
      }
      case 'poll':
      case 'pollFirst':
      case 'removeFirst':
        return obj.items.shift() ?? null;
      case 'pop':
        if (c === 'ArrayDeque' || c === 'LinkedList') return obj.items.shift();
        if (!obj.items.length) throw this.err('EmptyStackException', node);
        return obj.items.pop();
      case 'pollLast':
      case 'removeLast':
        return obj.items.pop() ?? null;
      case 'peek':
      case 'peekFirst':
      case 'element':
        if (c === 'Stack') return obj.items[obj.items.length - 1] ?? null;
        return obj.items[0] ?? null;
      case 'peekLast':
        return obj.items[obj.items.length - 1] ?? null;
      case 'size':
        return obj.items.length;
      case 'isEmpty':
        return obj.items.length === 0;
      case 'contains':
        return obj.items.some((x) => this.keyEq(x, args[0]));
      case 'indexOf':
        return obj.items.findIndex((x) => this.keyEq(x, args[0]));
      case 'clear':
        obj.items.length = 0;
        return null;
      default:
        throw this.err(`Unknown ${c} method '.${name}()'`, node);
    }
  }

  mapMethod(obj, name, args, node) {
    switch (name) {
      case 'put': {
        const hit = obj.entries.find(([k]) => this.keyEq(k, args[0]));
        if (hit) {
          const old = hit[1];
          hit[1] = args[1];
          return old;
        }
        obj.entries.push([args[0], args[1]]);
        return null;
      }
      case 'get': {
        const hit = obj.entries.find(([k]) => this.keyEq(k, args[0]));
        return hit ? hit[1] : null;
      }
      case 'getOrDefault': {
        const hit = obj.entries.find(([k]) => this.keyEq(k, args[0]));
        return hit ? hit[1] : args[1];
      }
      case 'containsKey':
        return obj.entries.some(([k]) => this.keyEq(k, args[0]));
      case 'containsValue':
        return obj.entries.some(([, v]) => this.keyEq(v, args[0]));
      case 'remove': {
        const i = obj.entries.findIndex(([k]) => this.keyEq(k, args[0]));
        return i === -1 ? null : obj.entries.splice(i, 1)[0][1];
      }
      case 'size':
        return obj.entries.length;
      case 'isEmpty':
        return obj.entries.length === 0;
      case 'keySet':
        return obj.entries.map(([k]) => k);
      case 'values':
        return obj.entries.map(([, v]) => v);
      case 'clear':
        obj.entries.length = 0;
        return null;
      default:
        throw this.err(`Unknown map method '.${name}()'`, node);
    }
  }

  setMethod(obj, name, args, node) {
    switch (name) {
      case 'add': {
        if (obj.items.some((x) => this.keyEq(x, args[0]))) return false;
        obj.items.push(args[0]);
        if (obj.label === 'TreeSet') obj.items.sort((a, b) => this.toNum(a, node) - this.toNum(b, node));
        return true;
      }
      case 'contains':
        return obj.items.some((x) => this.keyEq(x, args[0]));
      case 'remove': {
        const i = obj.items.findIndex((x) => this.keyEq(x, args[0]));
        if (i === -1) return false;
        obj.items.splice(i, 1);
        return true;
      }
      case 'size':
        return obj.items.length;
      case 'isEmpty':
        return obj.items.length === 0;
      case 'clear':
        obj.items.length = 0;
        return null;
      default:
        throw this.err(`Unknown set method '.${name}()'`, node);
    }
  }

  sbMethod(obj, name, args, node) {
    const cur = obj.fields.get('value');
    switch (name) {
      case 'append':
        obj.fields.set('value', cur + this.javaStr(args[0]));
        return new Ref(obj.id);
      case 'toString':
        return cur;
      case 'reverse':
        obj.fields.set('value', [...cur].reverse().join(''));
        return new Ref(obj.id);
      case 'length':
        return cur.length;
      case 'charAt':
        return new CharVal(cur[this.toNum(args[0], node)] ?? '\0');
      case 'deleteCharAt': {
        const i = this.toNum(args[0], node);
        obj.fields.set('value', cur.slice(0, i) + cur.slice(i + 1));
        return new Ref(obj.id);
      }
      default:
        throw this.err(`Unknown StringBuilder method '.${name}()'`, node);
    }
  }

  stringMethod(s, name, args, node) {
    switch (name) {
      case 'length':
        return s.length;
      case 'charAt': {
        const i = this.toNum(args[0], node);
        if (i < 0 || i >= s.length) throw this.err(`StringIndexOutOfBoundsException: index ${i}`, node);
        return new CharVal(s[i]);
      }
      case 'substring':
        return args.length > 1 ? s.slice(this.toNum(args[0], node), this.toNum(args[1], node)) : s.slice(this.toNum(args[0], node));
      case 'indexOf':
        return s.indexOf(args[0] instanceof CharVal ? args[0].ch : args[0]);
      case 'equals':
        return s === args[0];
      case 'equalsIgnoreCase':
        return typeof args[0] === 'string' && s.toLowerCase() === args[0].toLowerCase();
      case 'contains':
        return s.includes(args[0]);
      case 'startsWith':
        return s.startsWith(args[0]);
      case 'endsWith':
        return s.endsWith(args[0]);
      case 'toUpperCase':
        return s.toUpperCase();
      case 'toLowerCase':
        return s.toLowerCase();
      case 'trim':
        return s.trim();
      case 'isEmpty':
        return s.length === 0;
      case 'split': {
        const obj = this.ctx.heap.alloc('array', `String[${0}]`);
        obj.items = s.split(args[0] === ' ' ? ' ' : new RegExp(args[0]));
        obj.label = `String[${obj.items.length}]`;
        return new Ref(obj.id);
      }
      case 'toCharArray': {
        const obj = this.ctx.heap.alloc('array', `char[${s.length}]`);
        obj.items = [...s].map((ch) => new CharVal(ch));
        return new Ref(obj.id);
      }
      case 'compareTo':
        return s < args[0] ? -1 : s > args[0] ? 1 : 0;
      case 'replace':
        return s.split(args[0] instanceof CharVal ? args[0].ch : args[0]).join(args[1] instanceof CharVal ? args[1].ch : args[1]);
      case 'repeat':
        return s.repeat(this.toNum(args[0], node));
      default:
        throw this.err(`Unknown String method '.${name}()'`, node);
    }
  }

  scannerMethod(name, args, node) {
    switch (name) {
      case 'nextInt':
        return parseInt(this.ctx.readToken(), 10) || 0;
      case 'nextLong':
        return parseInt(this.ctx.readToken(), 10) || 0;
      case 'nextDouble':
      case 'nextFloat':
        return parseFloat(this.ctx.readToken()) || 0;
      case 'next':
        return this.ctx.readToken();
      case 'nextLine':
        return this.ctx.readLine();
      case 'nextBoolean': {
        const t = this.ctx.readToken().toLowerCase();
        return t === 'true' || t === '1';
      }
      case 'hasNext':
      case 'hasNextInt':
      case 'hasNextLong':
      case 'hasNextDouble':
      case 'hasNextLine':
        return name === 'hasNextLine' ? this.ctx.hasMoreLines() : this.ctx.hasMoreTokens();
      case 'close':
        return null;
      default:
        throw this.err(`Unknown Scanner method '.${name}()'`, node);
    }
  }

  callBuiltin(name, args, node) {
    switch (name) {
      case '__println':
        this.ctx.write((args.length ? this.javaStr(args[0]) : '') + '\n');
        return null;
      case '__print':
        this.ctx.write(this.javaStr(args[0]));
        return null;
      case '__printf': {
        const fmt = String(args[0]);
        let ai = 1;
        this.ctx.write(
          fmt.replace(/%(\.\d+)?[dsfcb]|%n|%%/g, (m) => {
            if (m === '%%') return '%';
            if (m === '%n') return '\n';
            const a = args[ai++];
            if (m.endsWith('f')) {
              const prec = m.match(/\.(\d+)/);
              return this.toNum(a, node).toFixed(prec ? +prec[1] : 6);
            }
            if (m.endsWith('d')) return String(Math.trunc(this.toNum(a, node)));
            if (m.endsWith('c')) return a instanceof CharVal ? a.ch : String.fromCharCode(this.toNum(a, node));
            return this.javaStr(a);
          })
        );
        return null;
      }
      case 'Math.max':
        return Math.max(this.toNum(args[0], node), this.toNum(args[1], node));
      case 'Math.min':
        return Math.min(this.toNum(args[0], node), this.toNum(args[1], node));
      case 'Math.abs':
        return Math.abs(this.toNum(args[0], node));
      case 'Math.sqrt':
        return Math.sqrt(this.toNum(args[0], node));
      case 'Math.pow':
        return Math.pow(this.toNum(args[0], node), this.toNum(args[1], node));
      case 'Math.floor':
        return Math.floor(this.toNum(args[0], node));
      case 'Math.ceil':
        return Math.ceil(this.toNum(args[0], node));
      case 'Math.random':
        return Math.random();
      case 'Integer.parseInt':
      case 'Long.parseLong':
        return parseInt(args[0], 10) || 0;
      case 'Double.parseDouble':
        return parseFloat(args[0]) || 0;
      case 'Integer.valueOf':
        return typeof args[0] === 'string' ? parseInt(args[0], 10) : this.toNum(args[0], node);
      case 'Integer.toString':
      case 'String.valueOf':
        return this.javaStr(args[0]);
      case 'String.format': {
        const fmt = String(args[0]);
        let ai = 1;
        return fmt.replace(/%(\.\d+)?[dsfcb]|%n|%%/g, (m) => {
          if (m === '%%') return '%';
          if (m === '%n') return '\n';
          const a = args[ai++];
          if (m.endsWith('f')) {
            const prec = m.match(/\.(\d+)/);
            return this.toNum(a, node).toFixed(prec ? +prec[1] : 6);
          }
          if (m.endsWith('d')) return String(Math.trunc(this.toNum(a, node)));
          if (m.endsWith('c')) return a instanceof CharVal ? a.ch : String.fromCharCode(this.toNum(a, node));
          return this.javaStr(a);
        });
      }
      case 'Character.isDigit':
        return args[0] instanceof CharVal && /[0-9]/.test(args[0].ch);
      case 'Character.isLetter':
        return args[0] instanceof CharVal && /[a-zA-Z]/.test(args[0].ch);
      case 'Character.isLetterOrDigit':
        return args[0] instanceof CharVal && /[a-zA-Z0-9]/.test(args[0].ch);
      case 'Character.isWhitespace':
        return args[0] instanceof CharVal && /\s/.test(args[0].ch);
      case 'Character.isUpperCase':
        return args[0] instanceof CharVal && /[A-Z]/.test(args[0].ch);
      case 'Character.isLowerCase':
        return args[0] instanceof CharVal && /[a-z]/.test(args[0].ch);
      case 'Character.toUpperCase':
        return args[0] instanceof CharVal ? new CharVal(args[0].ch.toUpperCase()) : args[0];
      case 'Character.toLowerCase':
        return args[0] instanceof CharVal ? new CharVal(args[0].ch.toLowerCase()) : args[0];
      case 'Character.getNumericValue':
        return args[0] instanceof CharVal ? parseInt(args[0].ch, 10) : 0;
      case 'Arrays.toString': {
        const obj = args[0] instanceof Ref ? this.ctx.heap.deref(args[0]) : null;
        if (!obj) return 'null';
        return `[${obj.items.map((x) => this.javaStr(x)).join(', ')}]`;
      }
      case 'Arrays.fill': {
        const obj = args[0] instanceof Ref ? this.ctx.heap.deref(args[0]) : null;
        if (obj) {
          if (args.length >= 4) {
            const from = this.toNum(args[1], node);
            const to = this.toNum(args[2], node);
            for (let i = from; i < to; i++) obj.items[i] = args[3];
          } else {
            obj.items = obj.items.map(() => args[1]);
          }
        }
        return null;
      }
      case 'Arrays.sort': {
        const obj = args[0] instanceof Ref ? this.ctx.heap.deref(args[0]) : null;
        if (obj) {
          if (args.length >= 3) {
            const from = this.toNum(args[1], node);
            const to = this.toNum(args[2], node);
            const slice = obj.items.slice(from, to);
            slice.sort((a, b) => this.toNum(a, node) - this.toNum(b, node));
            for (let i = 0; i < slice.length; i++) obj.items[from + i] = slice[i];
          } else {
            obj.items.sort((a, b) => this.toNum(a, node) - this.toNum(b, node));
          }
        }
        return null;
      }
      case 'Collections.sort': {
        const obj = args[0] instanceof Ref ? this.ctx.heap.deref(args[0]) : null;
        if (obj) obj.items.sort((a, b) => this.toNum(a, node) - this.toNum(b, node));
        return null;
      }
      case 'Collections.reverse': {
        const obj = args[0] instanceof Ref ? this.ctx.heap.deref(args[0]) : null;
        if (obj) obj.items.reverse();
        return null;
      }
      case 'Collections.swap': {
        const obj = args[0] instanceof Ref ? this.ctx.heap.deref(args[0]) : null;
        if (obj) {
          const i = this.toNum(args[1], node);
          const j = this.toNum(args[2], node);
          [obj.items[i], obj.items[j]] = [obj.items[j], obj.items[i]];
        }
        return null;
      }
      case 'Collections.max':
      case 'Collections.min': {
        const vals = this.iterableToArray(args[0], node);
        return vals.reduce((a, b) => {
          const cmp = this.toNum(a, node) - this.toNum(b, node);
          return name.endsWith('max') ? (cmp >= 0 ? a : b) : cmp <= 0 ? a : b;
        });
      }
      default:
        throw this.err(
          `Unknown method '${name}' — StepWise covers common java.util / java.lang APIs used in DSA. Rewrite or simplify this call.`,
          node
        );
    }
  }
}

/* ============================ entry point ============================ */

export async function runJava(code, ctx) {
  const parser = await getParser('java');
  const tree = parser.parse(code);
  const bad = findSyntaxError(tree.rootNode);
  if (bad) throw new ParseError(`Invalid Java syntax near line ${ln(bad)}`, ln(bad));
  const program = new JavaNormalizer().program(tree.rootNode);
  const interp = new JavaInterp(ctx);

  let mainDecl = null;
  let mainClass = null;
  for (const cls of program.classes) {
    interp.classes.set(cls.name, cls);
    for (const m of cls.methods) {
      if (m.name === 'main' && m.isStatic) {
        mainDecl = m;
        mainClass = cls;
      }
    }
  }
  if (!mainDecl) throw new ParseError('No public static void main(String[] args) found', 1);

  // register the main class's static methods as global functions and
  // initialize its static fields as globals
  for (const m of mainClass.methods) {
    if (m.isStatic) ctx.globalFrame.declare(m.name, new FuncVal(m.name, m));
  }
  ctx.step(mainDecl.line, 'start', 'Program start');
  for (const f of mainClass.fields) {
    if (f.static) {
      const v = f.init ? interp.evalExpr(f.init) : interp.defaultFor(f.jtype);
      ctx.globalFrame.declare(f.name, v);
      ctx.step(f.line, 'line', `${f.name} = ${interp.repr(v)}`);
    }
  }
  interp.callJavaMethod(mainDecl, null, [null], { line: mainDecl.line }, 'main');
  ctx.step(ctx.currentLine ?? mainDecl.line, 'end', 'Program finished');
}
