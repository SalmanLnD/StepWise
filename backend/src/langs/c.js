import { Interp } from '../engine/interp-base.js';
import { BREAK, ParseError, StepwiseError } from '../engine/errors.js';
import { Ref, Ptr, CharVal, FuncVal } from '../engine/values.js';
import { getParser, findSyntaxError } from '../engine/parser-host.js';
import { ln, isNamed, parseType, unwrapDeclarator, unescapeC, parseNumber, unsupported } from './c-shared.js';

/* ============================ CST -> AST ============================ */

export class CNormalizer {
  constructor(langName = 'C') {
    this.langName = langName;
  }

  program(root) {
    const body = [];
    for (const c of root.namedChildren) {
      const s = this.topLevel(c);
      if (s) body.push(...(Array.isArray(s) ? s : [s]));
    }
    return { type: 'Program', line: 1, body };
  }

  topLevel(n) {
    switch (n.type) {
      case 'preproc_include':
      case 'preproc_def':
      case 'preproc_function_def':
      case 'preproc_call':
      case 'comment':
        return null;
      case 'using_declaration': // C++: using namespace std;
        return null;
      case 'function_definition':
        return this.funcDef(n);
      case 'declaration':
        return this.declaration(n);
      case 'struct_specifier':
        return this.structDef(n);
      case 'type_definition': {
        // typedef struct {...} Node;  or typedef struct Node Node;
        const inner = n.namedChildren.find((c) => c.type === 'struct_specifier');
        const alias = n.namedChildren[n.namedChildren.length - 1];
        if (inner && inner.childForFieldName('body')) {
          const s = this.structDef(inner, alias?.text);
          return s;
        }
        return null;
      }
      case ';':
        return null;
      default:
        return this.stmt(n); // tolerate statements at top level
    }
  }

  structDef(n, aliasName = null) {
    const name = aliasName ?? n.childForFieldName('name')?.text;
    const body = n.childForFieldName('body');
    if (!body) return null;
    const fields = [];
    const methods = [];
    for (const f of body.namedChildren) {
      if (f.type === 'field_declaration') {
        const ctype = parseType(f.childForFieldName('type'));
        for (const d of f.namedChildren.slice(1)) {
          if (d.type === 'field_declaration' || d.type === 'comment') continue;
          if (!isNamed(d)) continue;
          const u = unwrapDeclarator(d);
          if (u.name && d.type !== 'field_declaration_list') {
            fields.push({ name: u.name, ctype: { ...ctype, ptr: ctype.ptr + u.ptr }, dims: u.dims.length });
          }
        }
      } else if (f.type === 'function_definition') {
        methods.push(this.funcDef(f));
      }
    }
    return { type: 'StructDecl', line: ln(n), name, fields, methods };
  }

  funcDef(n) {
    const retType = parseType(n.childForFieldName('type'));
    const u = unwrapDeclarator(n.childForFieldName('declarator'));
    const params = [];
    if (u.params) {
      for (const p of u.params.namedChildren) {
        if (p.type !== 'parameter_declaration') continue;
        const ptype = parseType(p.childForFieldName('type'));
        const pd = p.childForFieldName('declarator');
        if (!pd) continue;
        const pu = unwrapDeclarator(pd);
        params.push({
          name: pu.name,
          ctype: { ...ptype, ptr: ptype.ptr + pu.ptr + (pu.dims.length ? 1 : 0) },
          isRef: pu.isRef,
        });
      }
    }
    const bodyNode = n.childForFieldName('body');
    const body = this.blockBody(bodyNode);
    return {
      type: 'FuncDecl',
      line: ln(n),
      name: u.name,
      params,
      retType: { ...retType, ptr: retType.ptr + u.ptr },
      body,
      bodyLine: bodyNode.namedChildren[0] ? ln(bodyNode.namedChildren[0]) : ln(n),
    };
  }

  blockBody(n) {
    const out = [];
    for (const c of n.namedChildren) {
      if (c.type === 'comment') continue;
      const s = this.stmt(c);
      if (s) out.push(...(Array.isArray(s) ? s : [s]));
    }
    return out;
  }

  stmt(n) {
    const line = ln(n);
    switch (n.type) {
      case 'compound_statement':
        return { type: 'Block', line, body: this.blockBody(n) };
      case 'expression_statement': {
        const inner = n.namedChildren[0];
        if (!inner) return null;
        return { type: 'ExprStmt', line, expr: this.expr(inner) };
      }
      case 'declaration':
        return this.declaration(n);
      case 'if_statement': {
        const cond = this.expr(n.childForFieldName('condition').namedChildren[0]);
        const cons = n.childForFieldName('consequence');
        const altClause = n.childForFieldName('alternative');
        const wrap = (s) => {
          const st = this.stmt(s);
          if (!st) return [];
          return st.type === 'Block' ? st.body : [st];
        };
        let elseBody = null;
        if (altClause) {
          const altStmt = altClause.namedChildren[0];
          elseBody = altStmt ? wrap(altStmt) : [];
        }
        return { type: 'If', line, cond, then: wrap(cons), else: elseBody };
      }
      case 'while_statement': {
        const cond = this.expr(n.childForFieldName('condition').namedChildren[0]);
        const body = this.stmt(n.childForFieldName('body'));
        return { type: 'While', line, cond, body: body?.type === 'Block' ? body.body : body ? [body] : [] };
      }
      case 'do_statement': {
        const cond = this.expr(n.childForFieldName('condition').namedChildren[0]);
        const body = this.stmt(n.childForFieldName('body'));
        return { type: 'DoWhile', line, cond, body: body?.type === 'Block' ? body.body : body ? [body] : [] };
      }
      case 'for_statement': {
        const initN = n.childForFieldName('initializer');
        const condN = n.childForFieldName('condition');
        const updN = n.childForFieldName('update');
        const bodyN = n.childForFieldName('body');
        const body = this.stmt(bodyN);
        let init = null;
        if (initN) {
          init =
            initN.type === 'declaration'
              ? this.declaration(initN)
              : { type: 'ExprStmt', line: ln(initN), expr: this.expr(initN) };
        }
        return {
          type: 'ForC',
          line,
          init,
          cond: condN ? this.expr(condN) : null,
          update: updN ? this.expr(updN) : null,
          body: body?.type === 'Block' ? body.body : body ? [body] : [],
        };
      }
      case 'for_range_loop': {
        // C++ range-for: handled here so subclass gets it free
        const declName = unwrapDeclarator(n.childForFieldName('declarator')).name;
        return {
          type: 'ForIn',
          line,
          targets: [declName],
          iter: this.expr(n.childForFieldName('right')),
          body: (() => {
            const b = this.stmt(n.childForFieldName('body'));
            return b?.type === 'Block' ? b.body : b ? [b] : [];
          })(),
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
      case 'struct_specifier':
        return this.structDef(n);
      case 'comment':
      case 'preproc_include':
      case 'preproc_def':
      case 'using_declaration':
        return null;
      case 'switch_statement': {
        const cond = this.expr(n.childForFieldName('condition').namedChildren[0]);
        const bodyN = n.childForFieldName('body');
        const cases = [];
        let defBody = null;
        for (const c of bodyN?.namedChildren ?? []) {
          if (c.type !== 'case_statement') continue;
          // case N: stmts…   OR   default: stmts…  (default has no value expr)
          const kids = c.namedChildren;
          const first = kids[0];
          const isDefault = !first || first.type.endsWith('_statement') || first.type === 'declaration' || first.type === 'compound_statement';
          let value = null;
          let stmtStart = 0;
          if (!isDefault) {
            value = this.expr(first);
            stmtStart = 1;
          }
          const body = [];
          for (let i = stmtStart; i < kids.length; i++) {
            const st = this.stmt(kids[i]);
            if (st) body.push(...(st.type === 'Block' ? st.body : [st]));
          }
          if (isDefault) defBody = body;
          else cases.push({ value, body });
        }
        return { type: 'Switch', line, cond, cases, default: defBody };
      }
      case 'case_statement':
        return null;
      case 'labeled_statement':
        return this.stmt(n.namedChildren[n.namedChildren.length - 1]);
      default:
        throw unsupported(n, this.langName);
    }
  }

  declaration(n) {
    const line = ln(n);
    const ctype = parseType(n.childForFieldName('type'));
    const decls = [];
    for (const d of n.namedChildren) {
      if (d === n.childForFieldName('type')) continue;
      if (d.type === 'init_declarator') {
        const declNode = d.childForFieldName('declarator');
        const u = unwrapDeclarator(declNode);
        const valueN = d.childForFieldName('value');
        decls.push({
          name: u.name,
          ctype: { ...ctype, ptr: ctype.ptr + u.ptr },
          isRef: u.isRef,
          dims: u.dims.map((dd) => (dd ? this.expr(dd) : null)),
          init: valueN ? this.initValue(valueN) : null,
        });
      } else if (
        d.type === 'identifier' ||
        d.type === 'pointer_declarator' ||
        d.type === 'array_declarator' ||
        d.type === 'reference_declarator'
      ) {
        const u = unwrapDeclarator(d);
        if (u.params) continue; // function prototype
        decls.push({
          name: u.name,
          ctype: { ...ctype, ptr: ctype.ptr + u.ptr },
          isRef: u.isRef,
          dims: u.dims.map((dd) => (dd ? this.expr(dd) : null)),
          init: null,
        });
      } else if (d.type === 'function_declarator') {
        return null; // prototype
      }
    }
    if (!decls.length) return null;
    return { type: 'VarDecl', line, decls };
  }

  initValue(n) {
    if (n.type === 'initializer_list') {
      return { type: 'ArrayLit', line: ln(n), items: n.namedChildren.map((c) => this.initValue(c)) };
    }
    if (n.type === 'argument_list') {
      // C++ constructor-style init: vector<int> v(5);  string s("hi");
      return { type: 'CtorArgs', line: ln(n), items: n.namedChildren.map((c) => this.expr(c)) };
    }
    return this.expr(n);
  }

  expr(n) {
    const line = ln(n);
    switch (n.type) {
      case 'number_literal':
        return { type: 'Num', line, value: parseNumber(n.text) };
      case 'string_literal':
        return { type: 'Str', line, value: unescapeC(n.text) };
      case 'char_literal':
        return { type: 'Char', line, value: unescapeC(n.text) || '\0' };
      case 'true':
        return { type: 'Bool', line, value: true };
      case 'false':
        return { type: 'Bool', line, value: false };
      case 'null':
      case 'nullptr':
        return { type: 'Null', line };
      case 'identifier':
        if (n.text === 'NULL' || n.text === 'nullptr') return { type: 'Null', line };
        if (n.text === 'INT_MAX') return { type: 'Num', line, value: 2147483647 };
        if (n.text === 'INT_MIN') return { type: 'Num', line, value: -2147483648 };
        return { type: 'Name', line, id: n.text };
      case 'concatenated_string':
        return {
          type: 'Str',
          line,
          value: n.namedChildren.map((c) => unescapeC(c.text)).join(''),
        };
      case 'binary_expression': {
        const op = n.childForFieldName('operator').text;
        const l = this.expr(n.childForFieldName('left'));
        const r = this.expr(n.childForFieldName('right'));
        if (op === '&&' || op === '||') return { type: 'Logic', line, op, l, r };
        return { type: 'Bin', line, op, l, r };
      }
      case 'unary_expression':
        return {
          type: 'Unary',
          line,
          op: n.childForFieldName('operator').text,
          operand: this.expr(n.childForFieldName('argument')),
        };
      case 'pointer_expression': {
        const op = n.childForFieldName('operator').text; // '*' or '&'
        return { type: 'Unary', line, op, operand: this.expr(n.childForFieldName('argument')) };
      }
      case 'update_expression': {
        const arg = n.childForFieldName('argument');
        const opNode = n.childForFieldName('operator');
        const post = n.firstChild.startIndex === arg.startIndex; // i++ vs ++i
        const delta = opNode.text === '++' ? 1 : -1;
        return { type: 'IncDec', line, target: this.expr(arg), delta, post };
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
      case 'conditional_expression':
        return {
          type: 'Ternary',
          line,
          cond: this.expr(n.childForFieldName('condition')),
          then: this.expr(n.childForFieldName('consequence')),
          else: this.expr(n.childForFieldName('alternative')),
        };
      case 'call_expression': {
        const fn = n.childForFieldName('function');
        const args = n.childForFieldName('arguments').namedChildren
          .filter((a) => a.type !== 'comment')
          .map((a) => this.expr(a));
        return { type: 'Call', line, callee: this.expr(fn), args };
      }
      case 'subscript_expression':
        return {
          type: 'Index',
          line,
          obj: this.expr(n.childForFieldName('argument')),
          index: this.expr(n.childForFieldName('index') ?? n.childForFieldName('indices')?.namedChildren[0]),
        };
      case 'field_expression': {
        const op = n.children.find((c) => c.text === '->' || c.text === '.');
        return {
          type: 'Attr',
          line,
          obj: this.expr(n.childForFieldName('argument')),
          name: n.childForFieldName('field').text,
          arrow: op?.text === '->',
        };
      }
      case 'parenthesized_expression':
        return this.expr(n.namedChildren[0]);
      case 'cast_expression':
        return {
          type: 'Cast',
          line,
          ctype: parseType(n.childForFieldName('type')),
          expr: this.expr(n.childForFieldName('value')),
        };
      case 'sizeof_expression':
        return { type: 'Num', line, value: 1, sizeof: true };
      case 'initializer_list':
        return { type: 'ArrayLit', line, items: n.namedChildren.map((c) => this.initValue(c)) };
      case 'comma_expression': {
        const parts = n.namedChildren.map((c) => this.expr(c));
        return { type: 'Comma', line, parts };
      }
      case 'qualified_identifier':
        // std::foo
        return this.expr(n.childForFieldName('name'));
      default:
        throw unsupported(n, this.langName);
    }
  }
}

/* ============================ evaluator ============================ */

export class CInterp extends Interp {
  constructor(ctx, langName = 'C') {
    super(ctx);
    this.langName = langName;
    this.structs = new Map(); // name -> {fields, methods}
  }

  /* ---- type helpers ---- */

  structNameOf(ctype) {
    if (!ctype) return null;
    if (ctype.base.startsWith('struct:')) return ctype.base.slice(7);
    if (ctype.base.startsWith('class:')) return ctype.base.slice(6);
    if (ctype.base.startsWith('named:')) {
      const nm = ctype.base.slice(6);
      return this.structs.has(nm) ? nm : null;
    }
    return this.structs.has(ctype.base) ? ctype.base : null;
  }

  typeLabel(ctype, dims = 0) {
    let base = ctype.base.replace(/^(struct:|named:|class:)/, '');
    return base + '*'.repeat(ctype.ptr) + '[]'.repeat(dims);
  }

  defaultValue(ctype, dims = []) {
    if (dims.length > 0) return null; // arrays handled by allocArray
    if (ctype.ptr > 0) return new Ptr(null);
    const sn = this.structNameOf(ctype);
    if (sn) return this.allocStruct(sn);
    switch (ctype.base) {
      case 'char':
        return new CharVal('\0');
      case 'bool':
        return false;
      case 'float':
      case 'double':
        return 0;
      default:
        return 0;
    }
  }

  allocStruct(name) {
    const def = this.structs.get(name);
    if (!def) throw this.err(`Unknown struct '${name}'`);
    const obj = this.ctx.heap.alloc('object', name);
    obj.meta.className = name;
    for (const f of def.fields) {
      obj.fields.set(f.name, f.dims > 0 ? new Ptr(null) : this.defaultValue(f.ctype));
    }
    return new Ref(obj.id);
  }

  allocArray(ctype, dimSizes, init = null, label = null) {
    const size = dimSizes[0];
    const obj = this.ctx.heap.alloc('array', label ?? this.typeLabel(ctype) + `[${size}]`);
    for (let i = 0; i < size; i++) {
      if (dimSizes.length > 1) {
        obj.items.push(this.allocArray(ctype, dimSizes.slice(1), null, this.typeLabel(ctype) + `[${dimSizes.slice(1).join('][')}]`));
      } else {
        obj.items.push(this.defaultValue(ctype));
      }
    }
    if (init) {
      init.items.forEach((itemNode, i) => {
        if (i >= obj.items.length && dimSizes[0] === Infinity) return;
        if (itemNode.type === 'ArrayLit' && dimSizes.length > 1) {
          const sub = this.ctx.heap.deref(obj.items[i]);
          itemNode.items.forEach((x, j) => (sub.items[j] = this.evalExpr(x)));
        } else {
          obj.items[i] = this.evalExpr(itemNode);
        }
      });
    }
    return new Ref(obj.id);
  }

  /* ---- declarations ---- */

  stmt_StructDecl(node) {
    this.structs.set(node.name, node);
  }

  stmt_VarDecl(node) {
    const notes = [];
    for (const d of node.decls) {
      const value = this.evalDecl(d, node);
      this.ctx.frame.declare(d.name, value);
      this.rememberType(d);
      notes.push(`${d.name} = ${this.repr(value)}`);
    }
    this.ctx.step(node.line, 'line', notes.join(', '));
  }

  rememberType(d) {
    const f = this.ctx.frame;
    if (!f.varTypes) f.varTypes = new Map();
    f.varTypes.set(d.name, { ...d.ctype, dims: d.dims?.length ?? 0 });
  }

  declaredType(name) {
    for (let i = this.ctx.frames.length - 1; i >= 0; i--) {
      const t = this.ctx.frames[i].varTypes?.get(name);
      if (t) return t;
    }
    return null;
  }

  evalDecl(d, node) {
    // array declaration
    if (d.dims && d.dims.length > 0) {
      const init = d.init && d.init.type === 'ArrayLit' ? d.init : null;
      const dimSizes = d.dims.map((dim, i) => {
        if (dim) return this.toNum(this.evalExpr(dim), node);
        if (init) return i === 0 ? init.items.length : (init.items[0]?.items?.length ?? 0);
        throw this.err(`Array '${d.name}' needs a size`, node);
      });
      if (d.ctype.base === 'char' && d.init && d.init.type === 'Str') {
        const s = this.evalExpr(d.init);
        const size = d.dims[0] ? dimSizes[0] : s.length + 1;
        const ref = this.allocArray(d.ctype, [size], null, `char[${size}]`);
        const obj = this.ctx.heap.deref(ref);
        [...s].forEach((ch, i) => (obj.items[i] = new CharVal(ch)));
        return ref;
      }
      return this.allocArray(d.ctype, dimSizes, init);
    }
    if (!d.init) {
      // plain struct variable gets storage immediately; scalars stay uninitialized (0)
      const sn = d.ctype.ptr === 0 ? this.structNameOf(d.ctype) : null;
      if (sn) return this.allocStruct(sn);
      return this.defaultValue(d.ctype);
    }
    if (d.init.type === 'ArrayLit') {
      // struct initializer: struct Point p = {1, 2};
      const sn = this.structNameOf(d.ctype);
      if (sn && d.ctype.ptr === 0) {
        const ref = this.allocStruct(sn);
        const obj = this.ctx.heap.deref(ref);
        const def = this.structs.get(sn);
        d.init.items.forEach((x, i) => {
          if (def.fields[i]) obj.fields.set(def.fields[i].name, this.evalExpr(x));
        });
        return ref;
      }
    }
    let v = this.evalExpr(d.init);
    v = this.coerceMalloc(v, d.ctype, node);
    return this.coerceDecl(v, d.ctype, node);
  }

  coerceDecl(v, ctype, node) {
    if (ctype.ptr === 0 && typeof v === 'number') {
      if (ctype.base === 'int' || ctype.base === 'long') return Math.trunc(v);
      if (ctype.base === 'char') return new CharVal(String.fromCharCode(v & 0xff));
      if (ctype.base === 'bool') return v !== 0;
    }
    if (ctype.ptr === 0 && ctype.base === 'bool' && typeof v === 'number') return v !== 0;
    return v;
  }

  coerceMalloc(v, ctype, node) {
    if (!(v instanceof MallocVal)) return v;
    const sn = ctype.ptr > 0 ? this.structNameOf({ ...ctype, ptr: 0 }) : null;
    if (sn) return this.allocStruct(sn);
    const count = Math.max(1, Math.round(v.count));
    const elem = { base: ctype.base.replace(/^(struct:|named:|class:)/, ''), ptr: Math.max(0, ctype.ptr - 1) };
    const ref = this.allocArray(elem, [count], null, `${this.typeLabel(elem)}[${count}] (heap)`);
    if (v.zeroed) {
      // calloc already zero-initialized by defaultValue
    }
    return ref;
  }

  /* ---- assignment with declared-type awareness ---- */

  assignName(name, value, node) {
    const t = this.declaredType(name);
    if (value instanceof MallocVal) {
      value = t ? this.coerceMalloc(value, t, node) : this.coerceMalloc(value, { base: 'int', ptr: 1 }, node);
    } else if (t) {
      value = this.coerceDecl(value, t, node);
    }
    super.assignName(name, value, node);
  }

  /* ---- pointers ---- */

  addrOf(target, node) {
    if (target.type === 'Name') {
      const v = this.ctx.frame.has(target.id) ? this.ctx.frame.get(target.id) : undefined;
      if (v instanceof Ref) return new Ptr({ id: v.id, offset: 0 });
      // pointer to a stack variable
      const frame = this.ctx.frame.has(target.id)
        ? this.ctx.frame
        : this.ctx.globalFrame.has(target.id)
          ? this.ctx.globalFrame
          : null;
      if (!frame) throw this.err(`Cannot take address of undeclared '${target.id}'`, node);
      return new Ptr({ frameId: frame.id, name: target.id });
    }
    if (target.type === 'Index') {
      const objVal = this.evalExpr(target.obj);
      const idx = this.toNum(this.evalExpr(target.index), node);
      const { obj, base } = this.resolveArray(objVal, node);
      return new Ptr({ id: obj.id, offset: base + idx });
    }
    if (target.type === 'Attr') {
      // &node->field — model as pointer to the object itself (field pointers are rare)
      throw this.err('Taking the address of a struct field is not supported', node);
    }
    throw this.err('Unsupported address-of target', node);
  }

  resolveArray(objVal, node) {
    if (objVal instanceof Ref) {
      const obj = this.ctx.heap.deref(objVal);
      if (obj) return { obj, base: 0 };
    }
    if (objVal instanceof Ptr && objVal.target && 'id' in objVal.target) {
      const obj = this.ctx.heap.get(objVal.target.id);
      if (obj) {
        if (obj.meta.freed) throw this.err('Use after free: this memory was already freed', node);
        return { obj, base: objVal.target.offset || 0 };
      }
    }
    throw this.err(`Value ${this.repr(objVal)} is not an array or pointer`, node);
  }

  readPtr(v, node) {
    if (v instanceof Ref) {
      const obj = this.ctx.heap.deref(v);
      if (obj?.kind === 'array') return obj.items[0];
      if (obj?.kind === 'object') return v; // *structRef == the struct
    }
    if (v instanceof Ptr) {
      if (!v.target) throw this.err('Segmentation fault: dereferencing a NULL pointer', node);
      if ('id' in v.target) {
        const obj = this.ctx.heap.get(v.target.id);
        if (!obj) throw this.err('Segmentation fault: dangling pointer', node);
        if (obj.meta.freed) throw this.err('Use after free: this memory was already freed', node);
        if (obj.kind === 'array') return obj.items[v.target.offset || 0];
        return new Ref(obj.id); // pointer to struct: deref yields the struct ref
      }
      const frame = this.ctx.frames.find((f) => f.id === v.target.frameId);
      if (!frame) throw this.err('Dangling pointer: the variable it pointed to no longer exists', node);
      return frame.get(v.target.name);
    }
    throw this.err(`Cannot dereference ${this.repr(v)}`, node);
  }

  writePtr(ptr, value, node) {
    if (ptr instanceof Ref) {
      const obj = this.ctx.heap.deref(ptr);
      if (obj?.kind === 'array') {
        obj.items[0] = value;
        return;
      }
    }
    if (ptr instanceof Ptr) {
      if (!ptr.target) throw this.err('Segmentation fault: writing through a NULL pointer', node);
      if ('id' in ptr.target) {
        const obj = this.ctx.heap.get(ptr.target.id);
        if (!obj) throw this.err('Segmentation fault: dangling pointer', node);
        if (obj.meta.freed) throw this.err('Use after free: this memory was already freed', node);
        if (obj.kind === 'array') {
          obj.items[ptr.target.offset || 0] = value;
          return;
        }
        throw this.err('Cannot write through this pointer', node);
      }
      const frame = this.ctx.frames.find((f) => f.id === ptr.target.frameId);
      if (!frame) throw this.err('Dangling pointer write', node);
      frame.set(ptr.target.name, value);
      return;
    }
    throw this.err(`Cannot write through ${this.repr(ptr)}`, node);
  }

  /* ---- struct member access ---- */

  getAttr(objVal, name, node) {
    let ref = objVal;
    if (objVal instanceof Ptr) ref = this.readPtr(objVal, node);
    if (ref instanceof Ref) {
      const obj = this.ctx.heap.deref(ref);
      if (obj?.meta.freed) throw this.err('Use after free: this memory was already freed', node);
      if (obj?.kind === 'object') {
        if (obj.fields.has(name)) return obj.fields.get(name);
        throw this.err(`'${obj.label}' has no member '${name}'`, node);
      }
    }
    throw this.err(`Cannot access member '.${name}' of ${this.repr(objVal)}`, node);
  }

  setAttr(objVal, name, value, node) {
    let ref = objVal;
    if (objVal instanceof Ptr) ref = this.readPtr(objVal, node);
    if (ref instanceof Ref) {
      const obj = this.ctx.heap.deref(ref);
      if (obj?.meta.freed) throw this.err('Use after free: this memory was already freed', node);
      if (obj?.kind === 'object') {
        if (!obj.fields.has(name)) throw this.err(`'${obj.label}' has no member '${name}'`, node);
        obj.fields.set(name, value);
        return;
      }
    }
    throw this.err(`Cannot set member '.${name}' on ${this.repr(objVal)}`, node);
  }

  /* ---- indexing (arrays + pointer offsets) ---- */

  getIndex(objVal, idx, node) {
    if (typeof objVal === 'string') {
      const i = this.toNum(idx, node);
      if (i < 0 || i > objVal.length) throw this.err('String index out of range', node);
      return new CharVal(i === objVal.length ? '\0' : objVal[i]);
    }
    const { obj, base } = this.resolveArray(objVal, node);
    const i = base + this.toNum(idx, node);
    if (i < 0 || i >= obj.items.length) {
      throw this.err(`Array index out of bounds: index ${i}, size ${obj.items.length}`, node);
    }
    return obj.items[i];
  }

  setIndex(objVal, idx, value, node) {
    const { obj, base } = this.resolveArray(objVal, node);
    const i = base + this.toNum(idx, node);
    if (i < 0 || i >= obj.items.length) {
      throw this.err(`Array index out of bounds: index ${i}, size ${obj.items.length}`, node);
    }
    obj.items[i] = value;
  }

  /* ---- operators ---- */

  binop(op, l, r, node) {
    // pointer arithmetic
    if ((l instanceof Ptr || l instanceof Ref) && typeof r === 'number' && (op === '+' || op === '-')) {
      const { obj, base } = this.resolveArray(l, node);
      return new Ptr({ id: obj.id, offset: base + (op === '+' ? r : -r) });
    }
    if (typeof l === 'number' && (r instanceof Ptr || r instanceof Ref) && op === '+') {
      return this.binop('+', r, l, node);
    }
    if ((l instanceof Ptr || l instanceof Ref) && (r instanceof Ptr || r instanceof Ref)) {
      if (op === '-') {
        const a = this.resolveArray(l, node);
        const b = this.resolveArray(r, node);
        return a.base - b.base;
      }
      const eq = this.ptrEquals(l, r);
      if (op === '==') return eq;
      if (op === '!=') return !eq;
    }
    if ((l instanceof Ptr && l.target == null) || (r instanceof Ptr && r.target == null) || l === null || r === null) {
      const ln = l instanceof Ptr ? l.target : l;
      const rn = r instanceof Ptr ? r.target : r;
      if (op === '==') return (ln == null) === (rn == null) && ln == null;
      if (op === '!=') return !((ln == null) === (rn == null) && ln == null);
    }
    // string comparison / concat (C++ std::string; in C only via strcmp but harmless)
    if (typeof l === 'string' || typeof r === 'string') {
      const ls = l instanceof CharVal ? l.ch : l;
      const rs = r instanceof CharVal ? r.ch : r;
      if (typeof ls === 'string' && typeof rs === 'string') {
        switch (op) {
          case '+':
            return ls + rs;
          case '==':
            return ls === rs;
          case '!=':
            return ls !== rs;
          case '<':
            return ls < rs;
          case '<=':
            return ls <= rs;
          case '>':
            return ls > rs;
          case '>=':
            return ls >= rs;
        }
      }
      if (op === '+' && typeof ls === 'string' && typeof rs === 'number') return ls + rs;
    }
    const a = this.toNum(l, node);
    const b = this.toNum(r, node);
    const bothInt = Number.isInteger(a) && Number.isInteger(b) && !(l instanceof CharVal && op === '+') ;
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        if (b === 0) {
          if (Number.isInteger(a) && Number.isInteger(b)) throw this.err('Division by zero', node);
          return a / b;
        }
        return Number.isInteger(a) && Number.isInteger(b) ? Math.trunc(a / b) : a / b;
      case '%':
        if (b === 0) throw this.err('Modulo by zero', node);
        return a % b;
      case '==':
        return a === b;
      case '!=':
        return a !== b;
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
      default:
        throw this.err(`Unsupported operator ${op}`, node);
    }
  }

  ptrEquals(l, r) {
    const norm = (p) => {
      if (p instanceof Ref) return { id: p.id, offset: 0 };
      if (p instanceof Ptr) return p.target ? { id: p.target.id, offset: p.target.offset || 0 } : null;
      return null;
    };
    const a = norm(l);
    const b = norm(r);
    if (a === null || b === null) return a === b;
    return a.id === b.id && a.offset === b.offset;
  }

  expr_Cast(node) {
    let v = this.evalExpr(node.expr);
    if (v instanceof MallocVal) {
      return this.coerceMalloc(v, node.ctype, node);
    }
    return this.coerceDecl(v, node.ctype, node);
  }

  expr_Comma(node) {
    let v = null;
    for (const p of node.parts) v = this.evalExpr(p);
    return v;
  }

  expr_ArrayLit(node) {
    const obj = this.ctx.heap.alloc('array', `array[${node.items.length}]`);
    obj.items = node.items.map((x) => this.evalExpr(x));
    return new Ref(obj.id);
  }

  /* ---- functions ---- */

  bindParams(decl, args, frame, self, node) {
    for (let i = 0; i < decl.params.length; i++) {
      const p = decl.params[i];
      let v = args[i];
      if (v === undefined) throw this.err(`Missing argument '${p.name}' for ${decl.name}()`, node);
      frame.declare(p.name, v);
      if (!frame.varTypes) frame.varTypes = new Map();
      if (p.ctype) frame.varTypes.set(p.name, p.ctype);
    }
  }

  /* ---- builtins ---- */

  formatPrintf(fmt, args, node) {
    let ai = 0;
    let out = '';
    let i = 0;
    while (i < fmt.length) {
      const c = fmt[i];
      if (c !== '%') {
        out += c;
        i++;
        continue;
      }
      let j = i + 1;
      while (j < fmt.length && /[-+ #0-9.lhz]/.test(fmt[j])) j++;
      const conv = fmt[j];
      const spec = fmt.slice(i, j + 1);
      i = j + 1;
      if (conv === '%') {
        out += '%';
        continue;
      }
      const arg = args[ai++];
      out += this.formatOne(spec, conv, arg, node);
    }
    return out;
  }

  formatOne(spec, conv, arg, node) {
    const precM = spec.match(/\.(\d+)/);
    const widthM = spec.match(/%(-?)(\d+)/);
    let s;
    switch (conv) {
      case 'd':
      case 'i':
      case 'u':
        s = String(Math.trunc(this.toNum(arg, node)));
        break;
      case 'f':
        s = this.toNum(arg, node).toFixed(precM ? +precM[1] : 6);
        break;
      case 'g':
        s = String(this.toNum(arg, node));
        break;
      case 'c':
        s = arg instanceof CharVal ? arg.ch : String.fromCharCode(this.toNum(arg, node));
        break;
      case 's':
        s = this.cString(arg, node);
        break;
      case 'p':
        s = arg instanceof Ptr && arg.target ? `0x${(9000 + (arg.target.id ?? 0) * 16).toString(16)}` : arg instanceof Ref ? `0x${(9000 + arg.id * 16).toString(16)}` : '0x0';
        break;
      case 'x':
        s = Math.trunc(this.toNum(arg, node)).toString(16);
        break;
      default:
        s = String(arg);
    }
    if (widthM) {
      const w = +widthM[2];
      s = widthM[1] === '-' ? s.padEnd(w) : s.padStart(w);
    }
    return s;
  }

  cString(v, node) {
    if (typeof v === 'string') return v;
    if (v instanceof Ref || v instanceof Ptr) {
      const { obj, base } = this.resolveArray(v, node);
      let out = '';
      for (let i = base; i < obj.items.length; i++) {
        const it = obj.items[i];
        const ch = it instanceof CharVal ? it.ch : typeof it === 'string' ? it : '\0';
        if (ch === '\0') break;
        out += ch;
      }
      return out;
    }
    return String(v);
  }

  stmt_Switch(node) {
    const v = this.evalExpr(node.cond);
    this.ctx.step(node.line, 'line', `switch (${this.repr(v)})`);
    let matched = false;
    const run = (body) => {
      try {
        this.execBlock(body);
      } catch (sig) {
        if (sig === BREAK) return 'break';
        throw sig;
      }
      return null;
    };
    for (const c of node.cases) {
      const cv = this.evalExpr(c.value);
      if (!matched && this.switchEq(v, cv)) matched = true;
      if (matched) {
        if (run(c.body) === 'break') return;
      }
    }
    if (!matched && node.default) run(node.default);
  }

  switchEq(a, b) {
    if (a instanceof CharVal && b instanceof CharVal) return a.ch === b.ch;
    if (a instanceof CharVal) return a.ch.charCodeAt(0) === Number(b);
    if (b instanceof CharVal) return Number(a) === b.ch.charCodeAt(0);
    return Number(a) === Number(b);
  }

  callBuiltin(name, args, node) {
    switch (name) {
      case 'printf': {
        this.ctx.write(this.formatPrintf(this.cString(args[0], node), args.slice(1), node));
        return args.length;
      }
      case 'puts':
        this.ctx.write(this.cString(args[0], node) + '\n');
        return 0;
      case 'putchar':
        this.ctx.write(args[0] instanceof CharVal ? args[0].ch : String.fromCharCode(this.toNum(args[0], node)));
        return 0;
      case 'scanf': {
        const fmt = this.cString(args[0], node);
        const convs = fmt.match(/%[dioufcs]|%l?l?[dfu]/g) ?? [];
        let ai = 1;
        for (const cv of convs) {
          const tok = this.ctx.readToken();
          const ptr = args[ai++];
          let v;
          if (cv.includes('f')) v = parseFloat(tok) || 0;
          else if (cv.includes('c')) v = new CharVal(tok[0] ?? '\0');
          else if (cv.includes('s')) v = tok;
          else v = parseInt(tok, 10) || 0;
          if (cv.includes('s') && (ptr instanceof Ref || ptr instanceof Ptr)) {
            const { obj, base } = this.resolveArray(ptr, node);
            [...tok].forEach((ch, k) => (obj.items[base + k] = new CharVal(ch)));
            if (base + tok.length < obj.items.length) obj.items[base + tok.length] = new CharVal('\0');
          } else {
            this.writePtr(ptr, v, node);
          }
        }
        return convs.length;
      }
      case 'malloc':
        return new MallocVal(this.toNum(args[0], node), false);
      case 'calloc':
        return new MallocVal(this.toNum(args[0], node) * this.toNum(args[1] ?? 1, node), true);
      case 'free': {
        const p = args[0];
        const id = p instanceof Ref ? p.id : p instanceof Ptr && p.target && 'id' in p.target ? p.target.id : null;
        if (id == null) throw this.err('free() expects a heap pointer', node);
        const obj = this.ctx.heap.get(id);
        if (!obj) throw this.err('Double free or invalid free', node);
        if (obj.meta.freed) throw this.err('Double free detected', node);
        obj.meta.freed = true;
        return null;
      }
      case 'strlen':
        return this.cString(args[0], node).length;
      case 'strcmp': {
        const a = this.cString(args[0], node);
        const b = this.cString(args[1], node);
        return a < b ? -1 : a > b ? 1 : 0;
      }
      case 'strcpy': {
        const dst = args[0];
        const s = this.cString(args[1], node);
        const { obj, base } = this.resolveArray(dst, node);
        [...s].forEach((ch, k) => (obj.items[base + k] = new CharVal(ch)));
        if (base + s.length < obj.items.length) obj.items[base + s.length] = new CharVal('\0');
        return dst;
      }
      case 'strcat': {
        const dst = args[0];
        const cur = this.cString(dst, node);
        const s = this.cString(args[1], node);
        const { obj, base } = this.resolveArray(dst, node);
        [...s].forEach((ch, k) => (obj.items[base + cur.length + k] = new CharVal(ch)));
        if (base + cur.length + s.length < obj.items.length) {
          obj.items[base + cur.length + s.length] = new CharVal('\0');
        }
        return dst;
      }
      case 'strncmp': {
        const n = this.toNum(args[2], node);
        const a = this.cString(args[0], node).slice(0, n);
        const b = this.cString(args[1], node).slice(0, n);
        return a < b ? -1 : a > b ? 1 : 0;
      }
      case 'atoi':
      case 'atol':
        return parseInt(this.cString(args[0], node), 10) || 0;
      case 'atof':
        return parseFloat(this.cString(args[0], node)) || 0;
      case 'qsort': {
        // qsort(base, nmemb, size, compar) — we sort the array in place numerically
        // (function-pointer comparators are accepted but ignored for DSA demos)
        const { obj, base } = this.resolveArray(args[0], node);
        const n = this.toNum(args[1], node);
        const slice = obj.items.slice(base, base + n);
        slice.sort((a, b) => {
          const an = a instanceof CharVal ? a.ch.charCodeAt(0) : Number(a);
          const bn = b instanceof CharVal ? b.ch.charCodeAt(0) : Number(b);
          return an - bn;
        });
        for (let i = 0; i < n; i++) obj.items[base + i] = slice[i];
        return null;
      }
      case 'abs':
      case 'fabs':
        return Math.abs(this.toNum(args[0], node));
      case 'sqrt':
        return Math.sqrt(this.toNum(args[0], node));
      case 'pow':
        return Math.pow(this.toNum(args[0], node), this.toNum(args[1], node));
      case 'floor':
        return Math.floor(this.toNum(args[0], node));
      case 'ceil':
        return Math.ceil(this.toNum(args[0], node));
      case 'sin':
        return Math.sin(this.toNum(args[0], node));
      case 'cos':
        return Math.cos(this.toNum(args[0], node));
      case 'tan':
        return Math.tan(this.toNum(args[0], node));
      case 'log':
        return Math.log(this.toNum(args[0], node));
      case 'log10':
        return Math.log10(this.toNum(args[0], node));
      case 'exp':
        return Math.exp(this.toNum(args[0], node));
      case 'fmod':
        return this.toNum(args[0], node) % this.toNum(args[1], node);
      case 'rand':
        return Math.floor(Math.random() * 32768);
      case 'srand':
        return null;
      case 'exit':
        throw new StepwiseError(`exit(${args[0] ?? 0}) called`, node?.line, 'Exit');
      default:
        throw this.err(`Unknown function '${name}' — StepWise covers the C stdlib used in DSA (stdio/stdlib/string/math). Rewrite or simplify this call.`, node);
    }
  }

  /* ---- repr ---- */

  reprBool(b) {
    return b ? 'true' : 'false';
  }

  repr(v) {
    if (v === null || v === undefined) return 'NULL';
    if (v instanceof Ptr) {
      if (!v.target) return 'NULL';
      if ('id' in v.target) {
        const obj = this.ctx.heap.get(v.target.id);
        if (!obj) return 'dangling';
        const off = v.target.offset ? `+${v.target.offset}` : '';
        return `→ ${obj.label}${off}`;
      }
      return `→ &${v.target.name}`;
    }
    if (v instanceof Ref) {
      const obj = this.ctx.heap.deref(v);
      if (obj?.kind === 'object') return `${obj.label}{…}`;
      if (obj?.label.startsWith('char[')) return `"${this.cString(v)}"`;
    }
    if (v instanceof MallocVal) return `malloc(${v.count})`;
    return super.repr(v);
  }
}

class MallocVal {
  constructor(count, zeroed) {
    this.count = count;
    this.zeroed = zeroed;
  }
}

/* ============================ entry point ============================ */

export async function runProgramCLike(code, ctx, { grammar, langName, InterpClass, NormClass }) {
  const parser = await getParser(grammar);
  const tree = parser.parse(code);
  const bad = findSyntaxError(tree.rootNode);
  if (bad) throw new ParseError(`Invalid ${langName} syntax near line ${ln(bad)}`, ln(bad));
  const norm = new NormClass(langName);
  const program = norm.program(tree.rootNode);
  const interp = new InterpClass(ctx, langName);

  // hoist declarations: structs & functions first, then global variables
  let mainDecl = null;
  const globals = [];
  for (const s of program.body) {
    if (s.type === 'FuncDecl') {
      interp.ctx.globalFrame.declare(s.name, new FuncVal(s.name, s));
      if (s.name === 'main') mainDecl = s;
    } else if (s.type === 'StructDecl') {
      interp.structs.set(s.name, s);
    } else {
      globals.push(s);
    }
  }
  if (!mainDecl) throw new ParseError(`No main() function found — ${langName} programs start at main()`, 1);

  ctx.step(mainDecl.line, 'start', 'Program start');
  for (const g of globals) interp.execStmt(g);
  interp.callFunction(new FuncVal('main', mainDecl), [], { line: mainDecl.line });
  ctx.step(ctx.currentLine ?? mainDecl.line, 'end', 'Program finished');
}

export async function runC(code, ctx) {
  await runProgramCLike(code, ctx, {
    grammar: 'c',
    langName: 'C',
    InterpClass: CInterp,
    NormClass: CNormalizer,
  });
}
