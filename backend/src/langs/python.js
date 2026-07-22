import { Interp } from '../engine/interp-base.js';
import { ParseError, ReturnSignal, StepwiseError } from '../engine/errors.js';
import { Ref, FuncVal, ClassVal, RangeVal } from '../engine/values.js';
import { getParser, findSyntaxError } from '../engine/parser-host.js';

/* ============================ CST -> AST ============================ */

const ln = (node) => node.startPosition.row + 1;

/** web-tree-sitter 0.20 exposes isNamed as a method; newer versions as a property */
const isNamed = (n) => (typeof n.isNamed === 'function' ? n.isNamed() : n.isNamed);

function normProgram(root) {
  return { type: 'Program', line: 1, body: normBody(root) };
}

function normBody(node) {
  const out = [];
  for (const c of node.namedChildren) {
    if (c.type === 'comment') continue;
    const s = normStmt(c);
    if (s) out.push(s);
  }
  return out;
}

function normStmt(n) {
  const line = ln(n);
  switch (n.type) {
    case 'expression_statement': {
      const inner = n.namedChildren[0];
      if (!inner) return null;
      if (inner.type === 'assignment' || inner.type === 'augmented_assignment') {
        return normAssign(inner);
      }
      if (inner.type === 'string') return null; // docstring
      return { type: 'ExprStmt', line, expr: normExpr(inner) };
    }
    case 'function_definition': {
      const name = n.childForFieldName('name').text;
      const params = normParams(n.childForFieldName('parameters'));
      const bodyNode = n.childForFieldName('body');
      const body = normBody(bodyNode);
      return {
        type: 'FuncDecl',
        line,
        name,
        params,
        body,
        isGenerator: bodyContainsYield(body),
        bodyLine: bodyNode.namedChildren[0] ? ln(bodyNode.namedChildren[0]) : line,
      };
    }
    case 'decorated_definition': {
      // ignore decorators, keep the function/class itself
      const def = n.namedChildren.find((c) => c.type === 'function_definition' || c.type === 'class_definition');
      if (def) return normStmt(def);
      throw new ParseError('Unsupported decorated definition', line);
    }
    case 'class_definition': {
      const name = n.childForFieldName('name').text;
      const methods = [];
      for (const c of n.childForFieldName('body').namedChildren) {
        if (c.type === 'function_definition') methods.push(normStmt(c));
      }
      return { type: 'ClassDecl', line, name, methods, fields: [] };
    }
    case 'if_statement': {
      const out = {
        type: 'If',
        line,
        cond: normExpr(n.childForFieldName('condition')),
        then: normBody(n.childForFieldName('consequence')),
        else: null,
      };
      let cur = out;
      for (const alt of n.namedChildren) {
        if (alt.type === 'elif_clause') {
          const elifNode = {
            type: 'If',
            line: ln(alt),
            cond: normExpr(alt.childForFieldName('condition')),
            then: normBody(alt.childForFieldName('consequence')),
            else: null,
          };
          cur.else = [elifNode];
          cur = elifNode;
        } else if (alt.type === 'else_clause') {
          cur.else = normBody(alt.childForFieldName('body'));
        }
      }
      return out;
    }
    case 'while_statement':
      return {
        type: 'While',
        line,
        cond: normExpr(n.childForFieldName('condition')),
        body: normBody(n.childForFieldName('body')),
      };
    case 'for_statement': {
      const left = n.childForFieldName('left');
      let targets;
      if (left.type === 'pattern_list' || left.type === 'tuple_pattern' || left.type === 'tuple') {
        targets = left.namedChildren.map((c) => c.text);
      } else {
        targets = [left.text];
      }
      return {
        type: 'ForIn',
        line,
        targets,
        iter: normExpr(n.childForFieldName('right')),
        body: normBody(n.childForFieldName('body')),
      };
    }
    case 'return_statement': {
      const v = n.namedChildren[0];
      return { type: 'Return', line, value: v ? normExpr(v) : null };
    }
    case 'break_statement':
      return { type: 'Break', line };
    case 'continue_statement':
      return { type: 'Continue', line };
    case 'pass_statement':
      return { type: 'Pass', line };
    case 'global_statement':
      return { type: 'Global', line, names: n.namedChildren.map((c) => c.text) };
    case 'nonlocal_statement':
      return { type: 'Nonlocal', line, names: n.namedChildren.map((c) => c.text) };
    case 'raise_statement': {
      const v = n.namedChildren[0];
      return { type: 'Throw', line, value: v ? normExpr(v) : null };
    }
    case 'try_statement': {
      const out = { type: 'Try', line, body: normBody(n.childForFieldName('body')), handlers: [], orelse: null, finalizer: null };
      for (const c of n.namedChildren) {
        if (c.type === 'except_clause') {
          // shapes:
          //   except: block
          //   except ValueError: block
          //   except ValueError as e:  → as_pattern(identifier, as_pattern_target)
          //   except (A, B) as e:
          let types = null;
          let alias = null;
          const named = c.namedChildren.filter((x) => x.type !== 'comment');
          const block = named.find((x) => x.type === 'block');
          const nonBlock = named.filter((x) => x !== block);
          if (nonBlock.length >= 1) {
            const t = nonBlock[0];
            if (t.type === 'as_pattern') {
              const typ = t.namedChildren[0];
              types = typ.type === 'tuple' ? typ.namedChildren.map((x) => x.text) : [typ.text];
              alias = t.namedChildren.find((x) => x.type === 'as_pattern_target')?.namedChildren[0]?.text
                ?? t.namedChildren[1]?.text
                ?? null;
            } else if (t.type === 'tuple') {
              types = t.namedChildren.map((x) => x.text);
            } else {
              types = [t.text];
            }
          }
          if (!alias && nonBlock.length >= 2) alias = nonBlock[1].text;
          out.handlers.push({ line: ln(c), types, alias, body: block ? normBody(block) : [] });
        } else if (c.type === 'else_clause') {
          out.orelse = normBody(c.childForFieldName('body'));
        } else if (c.type === 'finally_clause') {
          out.finalizer = normBody(c.namedChildren.find((x) => x.type === 'block') ?? c);
        }
      }
      return out;
    }
    case 'assert_statement': {
      const parts = n.namedChildren.map(normExpr);
      return { type: 'Assert', line, test: parts[0], msg: parts[1] ?? null };
    }
    case 'delete_statement': {
      const t = n.namedChildren[0];
      const targets = t?.type === 'expression_list' ? t.namedChildren.map(normExpr) : t ? [normExpr(t)] : [];
      return { type: 'Del', line, targets };
    }
    case 'with_statement': {
      const items = [];
      const clause = n.namedChildren.find((c) => c.type === 'with_clause');
      for (const w of clause?.namedChildren ?? []) {
        if (w.type !== 'with_item') continue;
        const v = w.childForFieldName('value');
        if (v?.type === 'as_pattern') {
          items.push({ ctx: normExpr(v.namedChildren[0]), alias: v.namedChildren[1]?.text ?? null });
        } else if (v) {
          items.push({ ctx: normExpr(v), alias: null });
        }
      }
      return { type: 'With', line, items, body: normBody(n.childForFieldName('body')) };
    }
    case 'import_statement': {
      const names = [];
      for (const c of n.namedChildren) {
        if (c.type === 'dotted_name') names.push({ module: c.text, alias: c.text });
        else if (c.type === 'aliased_import') {
          names.push({ module: c.childForFieldName('name').text, alias: c.childForFieldName('alias').text });
        }
      }
      return { type: 'Import', line, names };
    }
    case 'import_from_statement': {
      const mod = n.childForFieldName('module_name')?.text ?? '';
      const names = [];
      for (const c of n.namedChildren.slice(1)) {
        if (c.type === 'dotted_name') names.push({ name: c.text, alias: c.text });
        else if (c.type === 'aliased_import') {
          names.push({ name: c.childForFieldName('name').text, alias: c.childForFieldName('alias').text });
        } else if (c.type === 'wildcard_import') {
          names.push({ name: '*', alias: '*' });
        }
      }
      return { type: 'FromImport', line, module: mod, names };
    }
    case 'match_statement':
      throw new ParseError("match statements aren't supported yet — rewrite as if/elif chains", line);
    case 'comment':
      return null;
    default:
      throw new ParseError(`Unsupported Python statement: ${n.type.replace(/_/g, ' ')}`, line);
  }
}

function normParams(paramsNode) {
  const params = [];
  for (const p of paramsNode.namedChildren) {
    if (p.type === 'identifier') params.push({ name: p.text, default: null, star: null });
    else if (p.type === 'default_parameter') {
      params.push({ name: p.childForFieldName('name').text, default: normExpr(p.childForFieldName('value')), star: null });
    } else if (p.type === 'typed_parameter') {
      params.push({ name: p.namedChildren[0].text, default: null, star: null });
    } else if (p.type === 'typed_default_parameter') {
      params.push({ name: p.childForFieldName('name').text, default: normExpr(p.childForFieldName('value')), star: null });
    } else if (p.type === 'list_splat_pattern') {
      params.push({ name: p.namedChildren[0].text, default: null, star: '*' });
    } else if (p.type === 'dictionary_splat_pattern') {
      params.push({ name: p.namedChildren[0].text, default: null, star: '**' });
    }
  }
  return params;
}

function bodyContainsYield(stmts) {
  const seen = new Set();
  const walk = (x) => {
    if (!x || typeof x !== 'object' || seen.has(x)) return false;
    seen.add(x);
    if (x.type === 'Yield') return true;
    if (x.type === 'FuncDecl' || x.type === 'Lambda') return false; // nested scope
    for (const k of Object.keys(x)) {
      const v = x[k];
      if (Array.isArray(v)) {
        for (const it of v) if (walk(it)) return true;
      } else if (v && typeof v === 'object') {
        if (walk(v)) return true;
      }
    }
    return false;
  };
  return stmts.some(walk);
}

function normAssign(n) {
  const line = ln(n);
  if (n.type === 'augmented_assignment') {
    const opTok = n.children.find((c) => !isNamed(c) && c.text.endsWith('='))?.text ?? '+=';
    return {
      type: 'Assign',
      line,
      targets: [normExpr(n.childForFieldName('left'))],
      value: normExpr(n.childForFieldName('right')),
      op: opTok.slice(0, -1),
    };
  }
  // assignment; may be chained: a = b = expr
  const targets = [normExpr(n.childForFieldName('left'))];
  let right = n.childForFieldName('right');
  while (right && right.type === 'assignment') {
    targets.push(normExpr(right.childForFieldName('left')));
    right = right.childForFieldName('right');
  }
  return { type: 'Assign', line, targets, value: normExpr(right), op: null };
}

const CMP_OPS = new Set(['<', '<=', '>', '>=', '==', '!=', 'in', 'not in', 'is', 'is not']);

function normExpr(n) {
  const line = ln(n);
  switch (n.type) {
    case 'integer':
      return { type: 'Num', line, value: parseInt(n.text.replace(/_/g, ''), n.text.match(/^0[xX]/) ? 16 : n.text.match(/^0[bB]/) ? 2 : 10) };
    case 'float':
      return { type: 'Num', line, value: parseFloat(n.text) };
    case 'true':
      return { type: 'Bool', line, value: true };
    case 'false':
      return { type: 'Bool', line, value: false };
    case 'none':
      return { type: 'Null', line };
    case 'string':
      return normString(n);
    case 'concatenated_string': {
      let parts = n.namedChildren.map(normString);
      return parts.reduce((a, b) => ({ type: 'Bin', line, op: '+', l: a, r: b }));
    }
    case 'identifier':
      return { type: 'Name', line, id: n.text };
    case 'binary_operator': {
      const op = n.childForFieldName('operator').text;
      return {
        type: 'Bin',
        line,
        op,
        l: normExpr(n.childForFieldName('left')),
        r: normExpr(n.childForFieldName('right')),
      };
    }
    case 'comparison_operator': {
      const operands = n.namedChildren.map(normExpr);
      const ops = [];
      let prevAnonType = null;
      for (const c of n.children) {
        if (isNamed(c)) {
          prevAnonType = null;
          continue;
        }
        // multi-token operators ('is not', 'not in') appear as consecutive
        // anonymous tokens sharing the same token type
        if (CMP_OPS.has(c.type) && c.type !== prevAnonType) ops.push(c.type);
        prevAnonType = c.type;
      }
      let expr = { type: 'Bin', line, op: ops[0], l: operands[0], r: operands[1] };
      for (let i = 1; i < ops.length; i++) {
        expr = {
          type: 'Logic',
          line,
          op: '&&',
          l: expr,
          r: { type: 'Bin', line, op: ops[i], l: operands[i], r: operands[i + 1] },
        };
      }
      return expr;
    }
    case 'boolean_operator': {
      const op = n.childForFieldName('operator').text === 'and' ? '&&' : '||';
      return {
        type: 'Logic',
        line,
        op,
        l: normExpr(n.childForFieldName('left')),
        r: normExpr(n.childForFieldName('right')),
      };
    }
    case 'not_operator':
      return { type: 'Unary', line, op: 'not', operand: normExpr(n.childForFieldName('argument')) };
    case 'unary_operator':
      return {
        type: 'Unary',
        line,
        op: n.childForFieldName('operator').text,
        operand: normExpr(n.childForFieldName('argument')),
      };
    case 'conditional_expression': {
      const [then, cond, els] = n.namedChildren.map(normExpr);
      return { type: 'Ternary', line, cond, then, else: els };
    }
    case 'call': {
      const fn = n.childForFieldName('function');
      const args = [];
      const kwargs = [];
      const argsNode = n.childForFieldName('arguments');
      // bare generator: any(x for x in xs) — arguments field IS the generator_expression
      if (argsNode && (argsNode.type === 'generator_expression' || argsNode.type === 'list_comprehension')) {
        args.push(normExpr(argsNode));
      } else {
        for (const a of argsNode?.namedChildren ?? []) {
          if (a.type === 'keyword_argument') {
            kwargs.push([a.childForFieldName('name').text, normExpr(a.childForFieldName('value'))]);
          } else if (a.type === 'list_splat') {
            args.push({ type: 'Splat', line: ln(a), expr: normExpr(a.namedChildren[0]) });
          } else if (a.type === 'dictionary_splat') {
            kwargs.push(['**', normExpr(a.namedChildren[0])]);
          } else if (a.type !== 'comment') {
            args.push(normExpr(a));
          }
        }
      }
      return { type: 'Call', line, callee: normExpr(fn), args, kwargs };
    }
    case 'lambda': {
      const paramsNode = n.childForFieldName('parameters');
      const params = paramsNode ? normParams(paramsNode) : [];
      const bodyExpr = normExpr(n.childForFieldName('body'));
      return {
        type: 'Lambda',
        line,
        params,
        body: [{ type: 'Return', line, value: bodyExpr }],
      };
    }
    case 'named_expression': {
      return {
        type: 'Walrus',
        line,
        name: n.childForFieldName('name').text,
        value: normExpr(n.childForFieldName('value')),
      };
    }
    case 'yield': {
      const v = n.namedChildren[0];
      return { type: 'Yield', line, value: v ? normExpr(v) : null };
    }
    case 'attribute':
      return {
        type: 'Attr',
        line,
        obj: normExpr(n.childForFieldName('object')),
        name: n.childForFieldName('attribute').text,
      };
    case 'subscript': {
      const obj = normExpr(n.childForFieldName('value'));
      const sub = n.childForFieldName('subscript');
      if (sub.type === 'slice') {
        // slice children: expr? ':' expr? (':' expr?)?
        const groups = [[], [], []];
        let g = 0;
        for (const k of sub.children) {
          if (k.text === ':' && !isNamed(k)) g++;
          else if (isNamed(k)) groups[g].push(k);
        }
        return {
          type: 'SliceExpr',
          line,
          obj,
          lo: groups[0][0] ? normExpr(groups[0][0]) : null,
          hi: groups[1][0] ? normExpr(groups[1][0]) : null,
          step: groups[2][0] ? normExpr(groups[2][0]) : null,
        };
      }
      return { type: 'Index', line, obj, index: normExpr(sub) };
    }
    case 'list':
      return { type: 'ListLit', line, items: n.namedChildren.map((c) => (c.type === 'list_splat' ? { type: 'Splat', line: ln(c), expr: normExpr(c.namedChildren[0]) } : normExpr(c))) };
    case 'tuple':
      return { type: 'TupleLit', line, items: n.namedChildren.map((c) => (c.type === 'list_splat' ? { type: 'Splat', line: ln(c), expr: normExpr(c.namedChildren[0]) } : normExpr(c))) };
    case 'set':
      return { type: 'SetLit', line, items: n.namedChildren.map(normExpr) };
    case 'list_splat':
      return { type: 'Splat', line, expr: normExpr(n.namedChildren[0]) };
    case 'dictionary': {
      const entries = [];
      for (const p of n.namedChildren) {
        if (p.type === 'pair') {
          entries.push([normExpr(p.childForFieldName('key')), normExpr(p.childForFieldName('value'))]);
        }
      }
      return { type: 'DictLit', line, entries };
    }
    case 'list_comprehension':
    case 'set_comprehension':
    case 'generator_expression': {
      const body = normExpr(n.childForFieldName('body'));
      const { clauses, cond } = normCompClauses(n);
      return { type: 'ListComp', line, expr: body, clauses, cond, isSet: n.type === 'set_comprehension' };
    }
    case 'dictionary_comprehension': {
      const pair = n.namedChildren.find((c) => c.type === 'pair');
      const { clauses, cond } = normCompClauses(n);
      return {
        type: 'DictComp',
        line,
        key: normExpr(pair.childForFieldName('key')),
        value: normExpr(pair.childForFieldName('value')),
        clauses,
        cond,
      };
    }
    case 'list_splat_pattern':
      return { type: 'Starred', line, target: normExpr(n.namedChildren[0]) };
    case 'ellipsis':
      return { type: 'Null', line };
    case 'parenthesized_expression':
      return normExpr(n.namedChildren[0]);
    case 'expression_list':
    case 'pattern_list':
    case 'tuple_pattern':
      return { type: 'TupleLit', line, items: n.namedChildren.map(normExpr) };
    default:
      throw new ParseError(`Unsupported Python expression: ${n.type.replace(/_/g, ' ')}`, line);
  }
}

/** Comprehension clauses: one or more for-in clauses plus optional if filters (ANDed). */
function normCompClauses(n) {
  const clauses = [];
  const conds = [];
  for (const c of n.namedChildren) {
    if (c.type === 'for_in_clause') {
      const left = c.childForFieldName('left');
      const targets =
        left.type === 'pattern_list' || left.type === 'tuple_pattern'
          ? left.namedChildren.map((x) => x.text)
          : [left.text];
      clauses.push({ targets, iter: normExpr(c.childForFieldName('right')) });
    } else if (c.type === 'if_clause') {
      conds.push(normExpr(c.namedChildren[0]));
    }
  }
  const cond = conds.length
    ? conds.reduce((a, b) => ({ type: 'Logic', line: ln(n), op: '&&', l: a, r: b }))
    : null;
  return { clauses, cond };
}

function normString(n) {
  const line = ln(n);
  const parts = [];
  let isF = false;
  for (const c of n.children) {
    if (c.type === 'string_start') isF = c.text.toLowerCase().includes('f');
    else if (c.type === 'string_content') parts.push(unescapePy(c.text));
    else if (c.type === 'escape_sequence') parts.push(unescapePy(c.text));
    else if (c.type === 'interpolation') {
      let expr = null;
      let spec = null;
      let conv = null;
      for (const k of c.namedChildren) {
        if (k.type === 'format_specifier') spec = k.text.replace(/^:/, '');
        else if (k.type === 'type_conversion') conv = k.text.replace(/^!/, '');
        else if (!expr) expr = normExpr(k);
      }
      parts.push({ kind: 'interp', expr, spec, conv });
    }
  }
  if (!isF) {
    return { type: 'Str', line, value: parts.filter((p) => typeof p === 'string').join('') };
  }
  return { type: 'FString', line, parts };
}

function unescapePy(s) {
  return s.replace(/\\(n|t|r|\\|'|"|0)/g, (_, c) =>
    c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c === '0' ? '\0' : c
  );
}

/* ============================ evaluator ============================ */

class BoundMethod {
  constructor(fn, selfRef) {
    this.fn = fn;
    this.selfRef = selfRef;
  }
}

/** A raised (or caught) Python exception value. */
class PyExc {
  constructor(name, message) {
    this.name = name;
    this.message = message;
  }
}

/** A supported stdlib module (math, random, heapq, collections, string). */
class PyModule {
  constructor(name) {
    this.name = name;
  }
}

/** Result of iter() — a stateful iterator for next(). */
class IterVal {
  constructor(items) {
    this.items = items;
    this.pos = 0;
  }
}

/** Deterministic PRNG so traces are reproducible (mulberry32). */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODULE_MEMBERS = {
  math: {
    consts: { pi: Math.PI, e: Math.E, tau: Math.PI * 2, inf: Infinity, nan: NaN },
    fns: new Set(['sqrt', 'floor', 'ceil', 'fabs', 'pow', 'exp', 'log', 'log2', 'log10', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'gcd', 'lcm', 'factorial', 'comb', 'perm', 'trunc', 'hypot', 'degrees', 'radians', 'isclose', 'isnan', 'isinf', 'copysign', 'fmod']),
  },
  random: {
    consts: {},
    fns: new Set(['random', 'randint', 'randrange', 'choice', 'shuffle', 'uniform', 'sample', 'seed']),
  },
  heapq: {
    consts: {},
    fns: new Set(['heappush', 'heappop', 'heapify', 'heappushpop', 'nlargest', 'nsmallest']),
  },
  collections: {
    consts: {},
    fns: new Set(['deque', 'Counter', 'defaultdict', 'OrderedDict']),
    bare: true, // members are exposed under their own name
  },
  string: {
    consts: {
      ascii_lowercase: 'abcdefghijklmnopqrstuvwxyz',
      ascii_uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      ascii_letters: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
      digits: '0123456789',
      punctuation: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
    },
    fns: new Set([]),
  },
};

class PyInterp extends Interp {
  constructor(ctx) {
    super(ctx);
    this.blockScoped = false;
    this.globalDecls = new WeakMap(); // frame -> Set of names
    this.nonlocalDecls = new WeakMap(); // frame -> Set of names
    this.rng = makeRng(42);
    this.yieldStack = [];
  }

  /** A runtime error carrying a Python exception type (for except matching). */
  pyErr(name, message, node) {
    const e = new StepwiseError(message || name, node?.line ?? this.ctx.currentLine, name);
    e.pyExc = name;
    return e;
  }

  stmt_Global(node) {
    let set = this.globalDecls.get(this.ctx.frame);
    if (!set) this.globalDecls.set(this.ctx.frame, (set = new Set()));
    for (const name of node.names) set.add(name);
    this.ctx.step(node.line, 'line', `global ${node.names.join(', ')}`);
  }

  stmt_Nonlocal(node) {
    let set = this.nonlocalDecls.get(this.ctx.frame);
    if (!set) this.nonlocalDecls.set(this.ctx.frame, (set = new Set()));
    for (const name of node.names) set.add(name);
    this.ctx.step(node.line, 'line', `nonlocal ${node.names.join(', ')}`);
  }

  assignName(name, value) {
    const globals = this.globalDecls.get(this.ctx.frame);
    if (globals && globals.has(name)) return this.ctx.globalFrame.set(name, value);
    const nl = this.nonlocalDecls.get(this.ctx.frame);
    if (nl && nl.has(name)) {
      let c = this.ctx.frame.closure;
      while (c) {
        if (c.has(name)) return c.set(name, value);
        c = c.closure;
      }
    }
    this.ctx.frame.set(name, value);
  }

  expr_Name(node) {
    const f = this.ctx.frame;
    if (f.has(node.id)) return f.get(node.id);
    let c = f.closure;
    while (c) {
      if (c.has(node.id)) return c.get(node.id);
      c = c.closure;
    }
    if (f !== this.ctx.globalFrame && this.ctx.globalFrame.has(node.id)) {
      return this.ctx.globalFrame.get(node.id);
    }
    const builtin = this.lookupBuiltinName(node.id);
    if (builtin !== undefined) return builtin;
    throw this.pyErr('NameError', `name '${node.id}' is not defined`, node);
  }

  stmt_FuncDecl(node) {
    const fn = new FuncVal(node.name, node);
    if (this.ctx.frame !== this.ctx.globalFrame) fn.closure = this.ctx.frame;
    this.assignName(node.name, fn);
  }

  expr_Lambda(node) {
    const decl = { type: 'FuncDecl', name: '<lambda>', params: node.params, body: node.body, line: node.line, bodyLine: node.line };
    const fn = new FuncVal('<lambda>', decl);
    if (this.ctx.frame !== this.ctx.globalFrame) fn.closure = this.ctx.frame;
    return fn;
  }

  expr_Walrus(node) {
    const v = this.evalExpr(node.value);
    this.assignName(node.name, v);
    return v;
  }

  expr_Yield(node) {
    const v = node.value ? this.evalExpr(node.value) : null;
    const top = this.yieldStack[this.yieldStack.length - 1];
    if (!top) throw this.err(`'yield' outside a generator function`, node);
    top.push(v);
    return null;
  }

  /* ---- new statements ---- */

  stmt_Try(node) {
    this.ctx.step(node.line, 'line', 'try');
    try {
      try {
        this.execBlock(node.body);
        if (node.orelse) this.execBlock(node.orelse);
      } catch (e) {
        if (!(e instanceof StepwiseError) || e.kind === 'LimitExceeded' || e.kind === 'InputError') throw e;
        const excName = e.pyExc ?? 'Exception';
        const handler = node.handlers.find(
          (h) => !h.types || h.types.includes(excName) || h.types.includes('Exception') || h.types.includes('BaseException')
        );
        if (!handler) throw e;
        this.ctx.step(handler.line, 'line', `except ${excName}`);
        if (handler.alias) this.ctx.frame.set(handler.alias, new PyExc(excName, e.message));
        this.execBlock(handler.body);
      }
    } finally {
      if (node.finalizer) this.execBlock(node.finalizer);
    }
  }

  stmt_Throw(node) {
    if (!node.value) throw this.pyErr('RuntimeError', 'exception re-raised', node);
    const v = this.evalExpr(node.value);
    if (v instanceof PyExc) throw this.pyErr(v.name, v.message, node);
    if (v instanceof FuncVal && PY_EXC_NAMES.has(v.name)) throw this.pyErr(v.name, '', node);
    throw this.pyErr('Exception', this.toStr(v), node);
  }

  stmt_Assert(node) {
    const ok = this.truthy(this.evalExpr(node.test));
    this.ctx.step(node.line, 'line', `assert → ${this.reprBool(ok)}`);
    if (!ok) {
      const msg = node.msg ? this.toStr(this.evalExpr(node.msg)) : 'assertion failed';
      throw this.pyErr('AssertionError', msg, node);
    }
  }

  stmt_Del(node) {
    const names = [];
    for (const t of node.targets) {
      if (t.type === 'Name') {
        const s = this.ctx.frame.lookup(t.id);
        if (!s) throw this.pyErr('NameError', `name '${t.id}' is not defined`, t);
        s.delete(t.id);
        names.push(t.id);
      } else if (t.type === 'Index') {
        const objVal = this.evalExpr(t.obj);
        const idx = this.evalExpr(t.index);
        const obj = objVal instanceof Ref ? this.ctx.heap.deref(objVal) : null;
        if (obj?.kind === 'map') {
          const i = obj.entries.findIndex(([k]) => this.deepEqual(k, idx));
          if (i === -1) throw this.pyErr('KeyError', this.repr(idx), t);
          obj.entries.splice(i, 1);
        } else if (obj?.kind === 'array') {
          obj.items.splice(this.normIndex(obj, idx, t), 1);
        } else {
          throw this.err(`Cannot delete item from ${this.typeName(objVal)}`, t);
        }
        names.push(this.targetName(t));
      } else {
        throw this.err('Unsupported del target', t);
      }
    }
    this.ctx.step(node.line, 'line', `del ${names.join(', ')}`);
  }

  stmt_With(node) {
    for (const item of node.items) {
      const v = this.evalExpr(item.ctx);
      if (item.alias) this.assignName(item.alias, v);
    }
    this.ctx.step(node.line, 'line', 'with');
    this.execBlock(node.body);
  }

  stmt_Import(node) {
    for (const { module, alias } of node.names) {
      if (!MODULE_MEMBERS[module]) {
        throw this.err(`Module '${module}' is not available here — supported: ${Object.keys(MODULE_MEMBERS).join(', ')}`, node);
      }
      this.assignName(alias, new PyModule(module));
    }
    this.ctx.step(node.line, 'line', `import ${node.names.map((n) => n.alias).join(', ')}`);
  }

  stmt_FromImport(node) {
    const mod = MODULE_MEMBERS[node.module];
    if (!mod) {
      throw this.err(`Module '${node.module}' is not available here — supported: ${Object.keys(MODULE_MEMBERS).join(', ')}`, node);
    }
    for (const { name, alias } of node.names) {
      if (name === '*') {
        for (const k of Object.keys(mod.consts)) this.assignName(k, mod.consts[k]);
        for (const f of mod.fns) this.assignName(f, this.moduleFn(node.module, f));
      } else {
        this.assignName(alias, this.moduleMember(node.module, name, node));
      }
    }
    this.ctx.step(node.line, 'line', `from ${node.module} import …`);
  }

  moduleFn(module, name) {
    const bare = MODULE_MEMBERS[module].bare;
    return new FuncVal(bare ? name : `${module}.${name}`, null, 'builtin');
  }

  moduleMember(module, name, node) {
    const mod = MODULE_MEMBERS[module];
    if (name in mod.consts) return mod.consts[name];
    if (mod.fns.has(name)) return this.moduleFn(module, name);
    throw this.err(`module '${module}' has no attribute '${name}'`, node);
  }

  reprBool(b) {
    return b ? 'True' : 'False';
  }

  logicResult(v) {
    return v;
  }

  truthy(v) {
    if (v instanceof Ref) {
      const obj = this.ctx.heap.deref(v);
      if (obj) {
        if (obj.kind === 'array' || obj.kind === 'set') return obj.items.length > 0;
        if (obj.kind === 'map') return obj.entries.length > 0;
      }
      return true;
    }
    if (Array.isArray(v)) return v.length > 0;
    return super.truthy(v);
  }

  /* ---- data helpers ---- */

  newList(items, label = 'list') {
    const obj = this.ctx.heap.alloc('array', label);
    obj.items = items;
    return new Ref(obj.id);
  }

  newDict(entries) {
    const obj = this.ctx.heap.alloc('map', 'dict');
    obj.entries = entries;
    return new Ref(obj.id);
  }

  deepEqual(a, b) {
    if (a instanceof Ref && b instanceof Ref) {
      if (a.id === b.id) return true;
      const oa = this.ctx.heap.deref(a);
      const ob = this.ctx.heap.deref(b);
      if (!oa || !ob || oa.kind !== ob.kind) return false;
      if (oa.kind === 'array' || oa.kind === 'set') {
        if (oa.items.length !== ob.items.length) return false;
        return oa.items.every((x, i) => this.deepEqual(x, ob.items[i]));
      }
      if (oa.kind === 'map') {
        if (oa.entries.length !== ob.entries.length) return false;
        return oa.entries.every(([k, v]) => {
          const hit = ob.entries.find(([k2]) => this.deepEqual(k, k2));
          return hit && this.deepEqual(v, hit[1]);
        });
      }
      return false;
    }
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      // Python: True == 1
      return Number(a) === Number(b) && a !== null && b !== null;
    }
    return a === b;
  }

  contains(container, item, node) {
    if (typeof container === 'string') {
      if (typeof item !== 'string') return false;
      return container.includes(item);
    }
    if (container instanceof RangeVal) return container.toArray().includes(item);
    if (container instanceof Ref) {
      const obj = this.ctx.heap.deref(container);
      if (obj) {
        if (obj.kind === 'array' || obj.kind === 'set') return obj.items.some((x) => this.deepEqual(x, item));
        if (obj.kind === 'map') return obj.entries.some(([k]) => this.deepEqual(k, item));
      }
    }
    throw this.err(`'in' not supported for ${this.repr(container)}`, node);
  }

  binop(op, l, r, node) {
    switch (op) {
      case '+': {
        if (typeof l === 'number' && typeof r === 'number') return l + r;
        if (typeof l === 'string' && typeof r === 'string') return l + r;
        if (typeof l === 'boolean' || typeof r === 'boolean') {
          if (typeof l !== 'string' && typeof r !== 'string') return Number(l) + Number(r);
        }
        if (l instanceof Ref && r instanceof Ref) {
          const oa = this.ctx.heap.deref(l);
          const ob = this.ctx.heap.deref(r);
          if (oa?.kind === 'array' && ob?.kind === 'array') {
            return this.newList([...oa.items, ...ob.items], oa.label);
          }
        }
        throw this.err(`Cannot add ${this.typeName(l)} and ${this.typeName(r)}`, node);
      }
      case '-':
        return this.toNum(l, node) - this.toNum(r, node);
      case '*': {
        if (typeof l === 'string' && typeof r === 'number') return l.repeat(Math.max(0, r));
        if (typeof r === 'string' && typeof l === 'number') return r.repeat(Math.max(0, l));
        if (l instanceof Ref && typeof r === 'number') {
          const obj = this.ctx.heap.deref(l);
          if (obj?.kind === 'array') {
            const items = [];
            for (let i = 0; i < r; i++) items.push(...obj.items);
            return this.newList(items, obj.label);
          }
        }
        return this.toNum(l, node) * this.toNum(r, node);
      }
      case '/': {
        const d = this.toNum(r, node);
        if (d === 0) throw this.err('ZeroDivisionError: division by zero', node);
        return this.toNum(l, node) / d;
      }
      case '//': {
        const d = this.toNum(r, node);
        if (d === 0) throw this.err('ZeroDivisionError: integer division by zero', node);
        return Math.floor(this.toNum(l, node) / d);
      }
      case '%': {
        const a = this.toNum(l, node);
        const b = this.toNum(r, node);
        if (b === 0) throw this.err('ZeroDivisionError: modulo by zero', node);
        return ((a % b) + b) % b;
      }
      case '**':
        return Math.pow(this.toNum(l, node), this.toNum(r, node));
      case '==':
        return this.deepEqual(l, r);
      case '!=':
        return !this.deepEqual(l, r);
      case 'is':
        return l instanceof Ref && r instanceof Ref ? l.id === r.id : l === r;
      case 'is not':
        return !(l instanceof Ref && r instanceof Ref ? l.id === r.id : l === r);
      case 'in':
        return this.contains(r, l, node);
      case 'not in':
        return !this.contains(r, l, node);
      case '<':
      case '<=':
      case '>':
      case '>=': {
        if (typeof l === 'string' && typeof r === 'string') {
          if (op === '<') return l < r;
          if (op === '<=') return l <= r;
          if (op === '>') return l > r;
          return l >= r;
        }
        const a = this.toNum(l, node);
        const b = this.toNum(r, node);
        if (op === '<') return a < b;
        if (op === '<=') return a <= b;
        if (op === '>') return a > b;
        return a >= b;
      }
      case '&':
        return this.toNum(l, node) & this.toNum(r, node);
      case '|':
        return this.toNum(l, node) | this.toNum(r, node);
      case '^':
        return this.toNum(l, node) ^ this.toNum(r, node);
      case '<<':
        return this.toNum(l, node) << this.toNum(r, node);
      case '>>':
        return this.toNum(l, node) >> this.toNum(r, node);
      default:
        throw this.err(`Unsupported operator ${op}`, node);
    }
  }

  typeName(v) {
    if (v === null) return 'NoneType';
    if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
    if (typeof v === 'string') return 'str';
    if (typeof v === 'boolean') return 'bool';
    if (v instanceof Ref) {
      const obj = this.ctx.heap.deref(v);
      return obj ? obj.label : 'object';
    }
    if (v instanceof RangeVal) return 'range';
    if (v instanceof FuncVal) return 'function';
    if (v instanceof ClassVal) return 'type';
    return 'object';
  }

  repr(v) {
    if (v === null || v === undefined) return 'None';
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    if (typeof v === 'string') return `'${v}'`;
    if (Array.isArray(v)) return `(${v.map((x) => this.repr(x)).join(', ')})`;
    if (v instanceof Ref) {
      const obj = this.ctx.heap.deref(v);
      if (obj?.kind === 'object' && obj.meta.className) return `<${obj.meta.className}>`;
      if (obj?.label === 'tuple') return this.reprObject(obj, 3).replace(/^\[/, '(').replace(/\]$/, ')');
    }
    return super.repr(v);
  }

  /** str() conversion (no quotes on strings) */
  toStr(v) {
    if (typeof v === 'string') return v;
    return this.repr(v);
  }

  /* ---- literals ---- */

  expandLitItems(items, node) {
    const out = [];
    for (const e of items) {
      if (e.type === 'Splat') out.push(...this.iterableToArray(this.evalExpr(e.expr), node));
      else out.push(this.evalExpr(e));
    }
    return out;
  }

  expr_ListLit(node) {
    return this.newList(this.expandLitItems(node.items, node));
  }

  expr_TupleLit(node) {
    return this.newList(this.expandLitItems(node.items, node), 'tuple');
  }

  expr_SetLit(node) {
    const obj = this.ctx.heap.alloc('set', 'set');
    for (const e of node.items) {
      const v = this.evalExpr(e);
      if (!obj.items.some((x) => this.deepEqual(x, v))) obj.items.push(v);
    }
    return new Ref(obj.id);
  }

  expr_DictLit(node) {
    return this.newDict(node.entries.map(([k, v]) => [this.evalExpr(k), this.evalExpr(v)]));
  }

  expr_FString(node) {
    let out = '';
    for (const p of node.parts) {
      if (typeof p === 'string') {
        out += p;
      } else if (p && p.kind === 'interp') {
        out += this.formatInterp(this.evalExpr(p.expr), p.spec, p.conv, node);
      } else {
        out += this.toStr(this.evalExpr(p));
      }
    }
    return out;
  }

  formatInterp(v, spec, conv, node) {
    let s;
    if (conv === 'r') s = this.repr(v);
    else if (conv === 'a') s = this.repr(v);
    else s = this.toStr(v);
    if (!spec) return s;
    // minimal format: [[fill]align][width][.precision][type]
    let fill = ' ';
    let align = '>';
    let rest = spec;
    if (/^.[<>=^]/.test(rest)) {
      fill = rest[0];
      align = rest[1];
      rest = rest.slice(2);
    } else if (/^[<>=^]/.test(rest)) {
      align = rest[0];
      rest = rest.slice(1);
    }
    const m = /^(\d+)?(?:\.(\d+))?([sdxfgeX%])?$/.exec(rest);
    if (!m) return s;
    const [, widthStr, precStr, type] = m;
    const width = widthStr ? parseInt(widthStr, 10) : 0;
    const prec = precStr != null ? parseInt(precStr, 10) : null;
    if (type === 'd' || type === 'f' || type === 'g' || type === 'e' || type === 'x' || type === 'X' || type === '%') {
      let n = this.toNum(v, node);
      if (type === '%') n *= 100;
      if (type === 'x') s = Math.trunc(n).toString(16);
      else if (type === 'X') s = Math.trunc(n).toString(16).toUpperCase();
      else if (type === 'd') s = String(Math.trunc(n));
      else if (type === 'e') s = n.toExponential(prec ?? 6);
      else if (type === 'g') s = n.toPrecision(prec ?? 6);
      else s = n.toFixed(prec ?? 6) + (type === '%' ? '%' : '');
    } else if (prec != null && typeof v === 'string') {
      s = s.slice(0, prec);
    }
    if (width > s.length) {
      const pad = fill.repeat(width - s.length);
      if (align === '<') s = s + pad;
      else if (align === '^') {
        const left = Math.floor(pad.length / 2);
        s = pad.slice(0, left) + s + pad.slice(left);
      } else s = pad + s;
    }
    return s;
  }

  bindCompTargets(targets, item, node) {
    if (targets.length === 1) this.ctx.frame.set(targets[0], item);
    else {
      const parts = this.iterableToArray(item, node);
      targets.forEach((t, i) => this.ctx.frame.set(t, parts[i]));
    }
  }

  runCompClauses(clauses, cond, node, emit) {
    const walk = (depth) => {
      if (depth >= clauses.length) {
        if (cond && !this.truthy(this.evalExpr(cond))) return;
        emit();
        return;
      }
      const cl = clauses[depth];
      const source = this.iterableToArray(this.evalExpr(cl.iter), node);
      for (const item of source) {
        this.ctx.tick(node.line);
        this.bindCompTargets(cl.targets, item, node);
        walk(depth + 1);
      }
    };
    walk(0);
  }

  expr_ListComp(node) {
    const items = [];
    const clauses = node.clauses ?? [{ targets: node.targets, iter: node.iter }];
    this.runCompClauses(clauses, node.cond, node, () => {
      const v = this.evalExpr(node.expr);
      if (node.isSet) {
        if (!items.some((x) => this.deepEqual(x, v))) items.push(v);
      } else {
        items.push(v);
      }
    });
    if (node.isSet) {
      const obj = this.ctx.heap.alloc('set', 'set');
      obj.items = items;
      return new Ref(obj.id);
    }
    return this.newList(items);
  }

  expr_DictComp(node) {
    const entries = [];
    this.runCompClauses(node.clauses, node.cond, node, () => {
      const k = this.evalExpr(node.key);
      const v = this.evalExpr(node.value);
      const i = entries.findIndex(([kk]) => this.deepEqual(kk, k));
      if (i >= 0) entries[i][1] = v;
      else entries.push([k, v]);
    });
    return this.newDict(entries);
  }

  expr_Splat(node) {
    // bare splat is only valid inside calls / list / tuple literals
    throw this.err('Cannot use starred expression here', node);
  }

  expr_SliceExpr(node) {
    const objVal = this.evalExpr(node.obj);
    const lo = node.lo ? this.toNum(this.evalExpr(node.lo), node) : null;
    const hi = node.hi ? this.toNum(this.evalExpr(node.hi), node) : null;
    const step = node.step ? this.toNum(this.evalExpr(node.step), node) : 1;
    const sliceArr = (arr) => {
      const n = arr.length;
      let s = step;
      let start = lo ?? (s > 0 ? 0 : n - 1);
      let stop = hi ?? (s > 0 ? n : -n - 1);
      if (start < 0) start += n;
      if (stop < 0 && hi !== null) stop += n;
      const out = [];
      if (s > 0) for (let i = Math.max(0, start); i < Math.min(n, stop); i += s) out.push(arr[i]);
      else for (let i = Math.min(n - 1, start); i > Math.max(-1, stop); i += s) out.push(arr[i]);
      return out;
    };
    if (typeof objVal === 'string') return sliceArr([...objVal]).join('');
    const obj = this.derefArray(objVal, node);
    return this.newList(sliceArr(obj.items), obj.label);
  }

  getIndex(objVal, idx, node) {
    if (typeof objVal === 'string') {
      let i = this.toNum(idx, node);
      if (i < 0) i += objVal.length;
      if (i < 0 || i >= objVal.length) throw this.err(`string index out of range`, node);
      return objVal[i];
    }
    if (Array.isArray(objVal)) {
      let i = this.toNum(idx, node);
      if (i < 0) i += objVal.length;
      return objVal[i];
    }
    if (objVal instanceof Ref) {
      const obj = this.ctx.heap.deref(objVal);
      if (obj?.kind === 'map') {
        const hit = obj.entries.find(([k]) => this.deepEqual(k, idx));
        if (hit) return hit[1];
        if (obj.meta?.defaultFactory) {
          const factory = obj.meta.defaultFactory;
          const v = factory instanceof FuncVal ? this.callAny(factory, [], node) : factory;
          obj.entries.push([idx, v]);
          return v;
        }
        throw this.pyErr('KeyError', this.repr(idx), node);
      }
    }
    return super.getIndex(objVal, idx, node);
  }

  setIndex(objVal, idx, value, node) {
    if (objVal instanceof Ref) {
      const obj = this.ctx.heap.deref(objVal);
      if (obj?.kind === 'map') {
        const hit = obj.entries.find(([k]) => this.deepEqual(k, idx));
        if (hit) hit[1] = value;
        else obj.entries.push([idx, value]);
        return;
      }
      if (obj?.label === 'tuple') throw this.err(`'tuple' object does not support item assignment`, node);
    }
    super.setIndex(objVal, idx, value, node);
  }

  /* ---- attributes & classes ---- */

  getAttr(objVal, name, node) {
    if (objVal instanceof Ref) {
      const obj = this.ctx.heap.deref(objVal);
      if (obj?.kind === 'object') {
        if (obj.fields.has(name)) return obj.fields.get(name);
        const cls = obj.meta.classDecl;
        if (cls) {
          const m = cls.methods.find((mm) => mm.name === name);
          if (m) return new BoundMethod(new FuncVal(name, m), objVal);
        }
        throw this.err(`'${obj.meta.className}' object has no attribute '${name}'`, node);
      }
    }
    throw this.err(`Cannot read attribute '.${name}' of ${this.repr(objVal)}`, node);
  }

  setAttr(objVal, name, value, node) {
    if (objVal instanceof Ref) {
      const obj = this.ctx.heap.deref(objVal);
      if (obj?.kind === 'object') {
        obj.fields.set(name, value);
        return;
      }
    }
    throw this.err(`Cannot set attribute '.${name}' on ${this.repr(objVal)}`, node);
  }

  instantiate(cls, args, node) {
    const obj = this.ctx.heap.alloc('object', cls.name);
    obj.meta.className = cls.name;
    obj.meta.classDecl = cls.decl;
    const ref = new Ref(obj.id);
    const init = cls.decl.methods.find((m) => m.name === '__init__');
    if (init) {
      this.callBound(new FuncVal('__init__', init), ref, args, node, `${cls.name}.__init__`);
    }
    return ref;
  }

  callBound(fn, selfRef, args, node, displayName) {
    const decl = fn.decl;
    const frame = this.ctx.pushFrame(displayName ?? fn.name, node?.line ?? decl.line);
    try {
      const params = decl.params;
      frame.declare(params[0]?.name ?? 'self', selfRef);
      for (let i = 1; i < params.length; i++) {
        let v = args[i - 1];
        if (v === undefined) {
          if (params[i].default) v = this.evalExpr(params[i].default);
          else throw this.err(`Missing argument '${params[i].name}'`, node);
        }
        frame.declare(params[i].name, v);
      }
      this.ctx.step(decl.bodyLine ?? decl.line, 'call', `${frame.name}(${args.map((a) => this.repr(a)).join(', ')})`);
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

  /* ---- calls ---- */

  /** Evaluate argument expressions, expanding f(*seq) splats. */
  evalArgList(argNodes, node) {
    const out = [];
    for (const a of argNodes) {
      if (a.type === 'Splat') out.push(...this.iterableToArray(this.evalExpr(a.expr), node));
      else out.push(this.evalExpr(a));
    }
    return out;
  }

  evalKwargList(kwargNodes) {
    if (!kwargNodes?.length) return null;
    const m = new Map();
    for (const [k, v] of kwargNodes) {
      if (k === '**') {
        const d = this.ctx.heap.deref(this.evalExpr(v));
        if (d?.kind === 'map') for (const [kk, vv] of d.entries) m.set(String(kk), vv);
      } else {
        m.set(k, this.evalExpr(v));
      }
    }
    return m;
  }

  expr_Call(node) {
    if (node.callee.type === 'Attr') {
      const objVal = this.evalExpr(node.callee.obj);
      const args = this.evalArgList(node.args, node);
      this.currentKwargs = this.evalKwargList(node.kwargs);
      if (objVal instanceof PyModule) {
        const member = this.moduleMember(objVal.name, node.callee.name, node);
        return this.callAny(member, args, node);
      }
      return this.callMethod(objVal, node.callee.name, args, node);
    }
    const fn = this.evalExpr(node.callee);
    const args = this.evalArgList(node.args, node);
    this.currentKwargs = this.evalKwargList(node.kwargs);
    return this.callAny(fn, args, node);
  }

  /** Dispatch any callable value. */
  callAny(fn, args, node) {
    if (fn instanceof BoundMethod) return this.callBound(fn.fn, fn.selfRef, args, node);
    if (fn instanceof FuncVal) return this.callFunction(fn, args, node);
    if (fn instanceof ClassVal) return this.instantiate(fn, args, node);
    throw this.pyErr('TypeError', `'${this.typeName(fn)}' object is not callable`, node);
  }

  callMethod(objVal, name, args, node) {
    // user-defined class method
    if (objVal instanceof Ref) {
      const obj = this.ctx.heap.deref(objVal);
      if (obj?.kind === 'object') {
        const attr = this.getAttr(objVal, name, node);
        if (attr instanceof BoundMethod) {
          const cn = obj.meta.className;
          return this.callBound(attr.fn, attr.selfRef, args, node, `${cn}.${name}`);
        }
        if (attr instanceof FuncVal) return this.callFunction(attr, args, node);
        throw this.err(`'${name}' is not callable`, node);
      }
      if (obj?.kind === 'array') return this.listMethod(obj, objVal, name, args, node);
      if (obj?.kind === 'map') return this.dictMethod(obj, name, args, node);
      if (obj?.kind === 'set') return this.setMethod(obj, name, args, node);
    }
    if (typeof objVal === 'string') return this.strMethod(objVal, name, args, node);
    throw this.err(`Unknown method '.${name}()' on ${this.repr(objVal)}`, node);
  }

  listMethod(obj, ref, name, args, node) {
    switch (name) {
      case 'append':
      case 'appendleft':
        if (name === 'appendleft') obj.items.unshift(args[0]);
        else obj.items.push(args[0]);
        return null;
      case 'pop':
      case 'popleft': {
        if (obj.items.length === 0) throw this.err('pop from empty list', node);
        if (name === 'popleft') return obj.items.shift();
        const i = args.length ? this.normIndex(obj, args[0], node) : obj.items.length - 1;
        return obj.items.splice(i, 1)[0];
      }
      case 'insert': {
        let i = this.toNum(args[0], node);
        if (i < 0) i = Math.max(0, obj.items.length + i);
        i = Math.min(i, obj.items.length);
        obj.items.splice(i, 0, args[1]);
        return null;
      }
      case 'remove': {
        const i = obj.items.findIndex((x) => this.deepEqual(x, args[0]));
        if (i === -1) throw this.err(`list.remove(x): ${this.repr(args[0])} not in list`, node);
        obj.items.splice(i, 1);
        return null;
      }
      case 'index': {
        const i = obj.items.findIndex((x) => this.deepEqual(x, args[0]));
        if (i === -1) throw this.err(`${this.repr(args[0])} is not in list`, node);
        return i;
      }
      case 'count':
        return obj.items.filter((x) => this.deepEqual(x, args[0])).length;
      case 'extend': {
        obj.items.push(...this.iterableToArray(args[0], node));
        return null;
      }
      case 'reverse':
        obj.items.reverse();
        return null;
      case 'sort': {
        const rev = this.currentKwargs?.get('reverse') === true;
        this.sortItems(obj.items, node);
        if (rev) obj.items.reverse();
        return null;
      }
      case 'clear':
        obj.items.length = 0;
        return null;
      case 'copy':
        return this.newList([...obj.items], obj.label);
      default:
        throw this.err(`Unknown list method '.${name}()'`, node);
    }
  }

  sortItems(items, node) {
    items.sort((a, b) => this.cmpVals(a, b, node));
  }

  cmpVals(a, b, node) {
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    // tuples / lists
    const aa = a instanceof Ref ? this.ctx.heap.deref(a) : null;
    const bb = b instanceof Ref ? this.ctx.heap.deref(b) : null;
    if (aa?.kind === 'array' && bb?.kind === 'array') {
      const n = Math.min(aa.items.length, bb.items.length);
      for (let i = 0; i < n; i++) {
        const c = this.cmpVals(aa.items[i], bb.items[i], node);
        if (c) return c;
      }
      return aa.items.length - bb.items.length;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const c = this.cmpVals(a[i], b[i], node);
        if (c) return c;
      }
      return a.length - b.length;
    }
    return this.toNum(a, node) - this.toNum(b, node);
  }

  dictMethod(obj, name, args, node) {
    switch (name) {
      case 'get': {
        const hit = obj.entries.find(([k]) => this.deepEqual(k, args[0]));
        return hit ? hit[1] : args.length > 1 ? args[1] : null;
      }
      case 'keys':
        return this.newList(obj.entries.map(([k]) => k));
      case 'values':
        return this.newList(obj.entries.map(([, v]) => v));
      case 'items':
        return this.newList(obj.entries.map(([k, v]) => this.newList([k, v], 'tuple')));
      case 'pop': {
        const i = obj.entries.findIndex(([k]) => this.deepEqual(k, args[0]));
        if (i === -1) {
          if (args.length > 1) return args[1];
          throw this.err(`KeyError: ${this.repr(args[0])}`, node);
        }
        return obj.entries.splice(i, 1)[0][1];
      }
      case 'setdefault': {
        const hit = obj.entries.find(([k]) => this.deepEqual(k, args[0]));
        if (hit) return hit[1];
        const v = args.length > 1 ? args[1] : null;
        obj.entries.push([args[0], v]);
        return v;
      }
      case 'clear':
        obj.entries.length = 0;
        return null;
      default:
        throw this.err(`Unknown dict method '.${name}()'`, node);
    }
  }

  setMethod(obj, name, args, node) {
    switch (name) {
      case 'add':
        if (!obj.items.some((x) => this.deepEqual(x, args[0]))) obj.items.push(args[0]);
        return null;
      case 'remove': {
        const i = obj.items.findIndex((x) => this.deepEqual(x, args[0]));
        if (i === -1) throw this.err(`KeyError: ${this.repr(args[0])}`, node);
        obj.items.splice(i, 1);
        return null;
      }
      case 'discard': {
        const i = obj.items.findIndex((x) => this.deepEqual(x, args[0]));
        if (i !== -1) obj.items.splice(i, 1);
        return null;
      }
      case 'pop':
        if (!obj.items.length) throw this.err('pop from an empty set', node);
        return obj.items.shift();
      case 'clear':
        obj.items.length = 0;
        return null;
      default:
        throw this.err(`Unknown set method '.${name}()'`, node);
    }
  }

  strMethod(s, name, args, node) {
    switch (name) {
      case 'upper':
        return s.toUpperCase();
      case 'lower':
        return s.toLowerCase();
      case 'strip':
        return s.trim();
      case 'lstrip':
        return s.replace(/^\s+/, '');
      case 'rstrip':
        return s.replace(/\s+$/, '');
      case 'split':
        return this.newList(args.length ? s.split(args[0]) : s.split(/\s+/).filter(Boolean));
      case 'join': {
        const parts = this.iterableToArray(args[0], node).map((x) => this.toStr(x));
        return parts.join(s);
      }
      case 'replace':
        return s.split(args[0]).join(args[1]);
      case 'find':
        return s.indexOf(args[0]);
      case 'index': {
        const i = s.indexOf(args[0]);
        if (i === -1) throw this.err('substring not found', node);
        return i;
      }
      case 'count': {
        if (args[0] === '') return s.length + 1;
        return s.split(args[0]).length - 1;
      }
      case 'startswith':
        return s.startsWith(args[0]);
      case 'endswith':
        return s.endsWith(args[0]);
      case 'isdigit':
        return s.length > 0 && /^[0-9]+$/.test(s);
      case 'isalpha':
        return s.length > 0 && /^[a-zA-Z]+$/.test(s);
      case 'isalnum':
        return s.length > 0 && /^[a-zA-Z0-9]+$/.test(s);
      case 'islower':
        return s === s.toLowerCase() && /[a-z]/.test(s);
      case 'isupper':
        return s === s.toUpperCase() && /[A-Z]/.test(s);
      case 'capitalize':
        return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
      case 'title':
        return s.replace(/\b\w/g, (c) => c.toUpperCase());
      case 'zfill':
        return s.padStart(this.toNum(args[0], node), '0');
      default:
        throw this.err(`Unknown string method '.${name}()'`, node);
    }
  }

  lookupBuiltinName(id) {
    if (PY_BUILTIN_NAMES.has(id)) return new FuncVal(id, null, 'builtin');
    return undefined;
  }

  callFunction(fn, args, node) {
    if (fn.kind === 'builtin') return this.callBuiltin(fn.name, args, node);
    if (fn.decl?.isGenerator) return this.callGenerator(fn, args, node);
    return super.callFunction(fn, args, node);
  }

  /** Run a generator function eagerly into a list (bounded by step limits). */
  callGenerator(fn, args, node) {
    const bucket = [];
    this.yieldStack.push(bucket);
    try {
      const ret = super.callFunction(fn, args, node);
      if (ret !== null && ret !== undefined) bucket.push(ret);
    } finally {
      this.yieldStack.pop();
    }
    return this.newList(bucket);
  }

  bindParams(decl, args, frame, self, node) {
    const params = decl.params ?? [];
    const kwargs = this.currentKwargs ?? new Map();
    const usedKw = new Set();
    let ai = 0;
    for (const p of params) {
      if (p.star === '*') {
        const rest = args.slice(ai);
        ai = args.length;
        frame.declare(p.name, this.newList(rest));
        continue;
      }
      if (p.star === '**') {
        const left = new Map();
        for (const [k, v] of kwargs) if (!usedKw.has(k)) left.set(k, v);
        frame.declare(p.name, this.newDict([...left.entries()]));
        usedKw.clear();
        for (const k of kwargs.keys()) usedKw.add(k);
        continue;
      }
      let v;
      if (kwargs.has(p.name)) {
        v = kwargs.get(p.name);
        usedKw.add(p.name);
      } else if (ai < args.length) {
        v = args[ai++];
      } else if (p.default != null) {
        v = this.evalExpr(p.default);
      } else {
        throw this.pyErr('TypeError', `Missing argument '${p.name}' for ${decl.name}()`, node);
      }
      frame.declare(p.name, v);
    }
    if (ai < args.length && !params.some((p) => p.star === '*')) {
      throw this.pyErr('TypeError', `${decl.name}() takes ${params.filter((p) => !p.star).length} positional arguments but ${args.length} were given`, node);
    }
    for (const k of kwargs.keys()) {
      if (!usedKw.has(k) && !params.some((p) => p.star === '**')) {
        throw this.pyErr('TypeError', `${decl.name}() got an unexpected keyword argument '${k}'`, node);
      }
    }
  }

  assignTo(target, value, node) {
    if (target.type === 'TupleLit' && target.items.some((t) => t.type === 'Starred')) {
      const vals = this.iterableToArray(value, node);
      const items = target.items;
      const starIdx = items.findIndex((t) => t.type === 'Starred');
      const before = items.slice(0, starIdx);
      const after = items.slice(starIdx + 1);
      if (vals.length < before.length + after.length) {
        throw this.pyErr('ValueError', `not enough values to unpack (expected at least ${before.length + after.length})`, node);
      }
      before.forEach((t, i) => super.assignTo(t, vals[i], node));
      const mid = vals.slice(before.length, vals.length - after.length);
      super.assignTo(items[starIdx].target, this.newList(mid), node);
      after.forEach((t, i) => super.assignTo(t, vals[vals.length - after.length + i], node));
      return;
    }
    return super.assignTo(target, value, node);
  }

  callBuiltin(name, args, node) {
    // module.fn dispatch
    if (name.includes('.')) {
      const [mod, fn] = name.split('.');
      return this.callModuleFn(mod, fn, args, node);
    }
    switch (name) {
      case 'print': {
        const sep = this.currentKwargs?.has('sep') ? this.currentKwargs.get('sep') : ' ';
        const end = this.currentKwargs?.has('end') ? this.currentKwargs.get('end') : '\n';
        this.ctx.write(args.map((a) => this.toStr(a)).join(sep) + end);
        return null;
      }
      case 'len': {
        const v = args[0];
        if (typeof v === 'string') return v.length;
        if (Array.isArray(v)) return v.length;
        if (v instanceof RangeVal) return v.toArray().length;
        if (v instanceof Ref) {
          const obj = this.ctx.heap.deref(v);
          if (obj?.kind === 'array' || obj?.kind === 'set') return obj.items.length;
          if (obj?.kind === 'map') return obj.entries.length;
        }
        throw this.err(`object of type '${this.typeName(v)}' has no len()`, node);
      }
      case 'range': {
        const nums = args.map((a) => this.toNum(a, node));
        if (nums.length === 1) return new RangeVal(0, nums[0], 1);
        if (nums.length === 2) return new RangeVal(nums[0], nums[1], 1);
        if (nums[2] === 0) throw this.err('range() arg 3 must not be zero', node);
        return new RangeVal(nums[0], nums[1], nums[2]);
      }
      case 'input': {
        if (args[0]) this.ctx.write(this.toStr(args[0]));
        const line = this.ctx.readLine();
        this.ctx.write(line + '\n');
        return line;
      }
      case 'int': {
        const v = args[0] ?? 0;
        if (typeof v === 'string') {
          const base = args[1] ? this.toNum(args[1], node) : 10;
          const n = parseInt(v.trim(), base);
          if (Number.isNaN(n)) throw this.pyErr('ValueError', `invalid literal for int(): '${v}'`, node);
          return n;
        }
        return Math.trunc(this.toNum(v, node));
      }
      case 'float': {
        const v = args[0] ?? 0;
        if (typeof v === 'string') {
          const n = parseFloat(v.trim());
          if (Number.isNaN(n)) throw this.pyErr('ValueError', `could not convert string to float: '${v}'`, node);
          return n;
        }
        return this.toNum(v, node);
      }
      case 'str':
        return args.length ? this.toStr(args[0]) : '';
      case 'bool':
        return args.length ? this.truthy(args[0]) : false;
      case 'abs':
        return Math.abs(this.toNum(args[0], node));
      case 'round': {
        const nd = args[1] ? this.toNum(args[1], node) : 0;
        const f = Math.pow(10, nd);
        return Math.round(this.toNum(args[0], node) * f) / f;
      }
      case 'pow':
        return Math.pow(this.toNum(args[0], node), this.toNum(args[1], node));
      case 'min':
      case 'max': {
        let vals = args.length === 1 ? this.iterableToArray(args[0], node) : args;
        if (!vals.length) throw this.err(`${name}() arg is an empty sequence`, node);
        return vals.reduce((a, b) => {
          const cmp =
            typeof a === 'string' && typeof b === 'string' ? (a < b ? -1 : 1) : this.toNum(a, node) - this.toNum(b, node);
          return name === 'min' ? (cmp <= 0 ? a : b) : cmp >= 0 ? a : b;
        });
      }
      case 'sum': {
        const vals = this.iterableToArray(args[0], node);
        let acc = args[1] !== undefined ? this.toNum(args[1], node) : 0;
        for (const v of vals) acc += this.toNum(v, node);
        return acc;
      }
      case 'sorted': {
        const vals = [...this.iterableToArray(args[0], node)];
        this.sortItems(vals, node);
        if (this.currentKwargs?.get('reverse') === true) vals.reverse();
        return this.newList(vals);
      }
      case 'reversed':
        return [...this.iterableToArray(args[0], node)].reverse();
      case 'enumerate': {
        const start = args[1] ? this.toNum(args[1], node) : 0;
        return this.iterableToArray(args[0], node).map((v, i) => [i + start, v]);
      }
      case 'zip': {
        const arrs = args.map((a) => this.iterableToArray(a, node));
        const n = Math.min(...arrs.map((a) => a.length));
        const out = [];
        for (let i = 0; i < n; i++) out.push(arrs.map((a) => a[i]));
        return out;
      }
      case 'list':
        return this.newList(args.length ? [...this.iterableToArray(args[0], node)] : []);
      case 'tuple':
        return this.newList(args.length ? [...this.iterableToArray(args[0], node)] : [], 'tuple');
      case 'set': {
        const obj = this.ctx.heap.alloc('set', 'set');
        if (args.length) {
          for (const v of this.iterableToArray(args[0], node)) {
            if (!obj.items.some((x) => this.deepEqual(x, v))) obj.items.push(v);
          }
        }
        return new Ref(obj.id);
      }
      case 'dict':
        return this.newDict([]);
      case 'ord':
        return String(args[0]).charCodeAt(0);
      case 'chr':
        return String.fromCharCode(this.toNum(args[0], node));
      case 'type':
        return this.typeName(args[0]);
      case 'map': {
        const fn = args[0];
        const seqs = args.slice(1).map((a) => this.iterableToArray(a, node));
        const n = Math.min(...seqs.map((s) => s.length));
        const out = [];
        for (let i = 0; i < n; i++) out.push(this.callAny(fn, seqs.map((s) => s[i]), node));
        return out; // iterable of results; list(map(...)) materializes via iterableToArray
      }
      case 'filter': {
        const fn = args[0];
        const vals = this.iterableToArray(args[1], node);
        return vals.filter((v) => (fn === null ? this.truthy(v) : this.truthy(this.callAny(fn, [v], node))));
      }
      case 'any':
        return this.iterableToArray(args[0], node).some((v) => this.truthy(v));
      case 'all':
        return this.iterableToArray(args[0], node).every((v) => this.truthy(v));
      case 'isinstance': {
        const v = args[0];
        const want = args[1];
        const names = Array.isArray(want) ? want : [want];
        const tn = this.typeName(v);
        return names.some((w) => {
          const n = typeof w === 'string' ? w : w instanceof FuncVal ? w.name : w instanceof ClassVal ? w.name : this.toStr(w);
          if (n === 'int' && tn === 'int') return true;
          if (n === 'float' && (tn === 'float' || tn === 'int')) return true;
          if (n === 'str' && tn === 'str') return true;
          if (n === 'bool' && tn === 'bool') return true;
          if (n === 'list' && v instanceof Ref && this.ctx.heap.deref(v)?.label === 'list') return true;
          if (n === 'tuple' && v instanceof Ref && this.ctx.heap.deref(v)?.label === 'tuple') return true;
          if (n === 'dict' && v instanceof Ref && this.ctx.heap.deref(v)?.kind === 'map') return true;
          if (n === 'set' && v instanceof Ref && this.ctx.heap.deref(v)?.kind === 'set') return true;
          if (v instanceof Ref && this.ctx.heap.deref(v)?.meta?.className === n) return true;
          return tn === n;
        });
      }
      case 'divmod': {
        const a = this.toNum(args[0], node);
        const b = this.toNum(args[1], node);
        if (b === 0) throw this.pyErr('ZeroDivisionError', 'division by zero', node);
        const q = Math.floor(a / b);
        return [q, a - q * b];
      }
      case 'id':
        return args[0] instanceof Ref ? args[0].id : Math.abs(this.hashVal(args[0]));
      case 'iter':
        return new IterVal(this.iterableToArray(args[0], node));
      case 'next': {
        const it = args[0];
        if (!(it instanceof IterVal)) throw this.pyErr('TypeError', 'next() expects an iterator from iter()', node);
        if (it.pos >= it.items.length) {
          if (args.length > 1) return args[1];
          throw this.pyErr('StopIteration', '', node);
        }
        return it.items[it.pos++];
      }
      case 'format':
        return this.formatInterp(args[0], args[1] ? this.toStr(args[1]) : '', null, node);
      case 'Exception':
      case 'ValueError':
      case 'TypeError':
      case 'KeyError':
      case 'IndexError':
      case 'RuntimeError':
      case 'AssertionError':
      case 'ZeroDivisionError':
      case 'NameError':
      case 'StopIteration':
        return new PyExc(name, args[0] != null ? this.toStr(args[0]) : '');
      // bare collections imports
      case 'deque':
        return this.callModuleFn('collections', 'deque', args, node);
      case 'Counter':
        return this.callModuleFn('collections', 'Counter', args, node);
      case 'defaultdict':
        return this.callModuleFn('collections', 'defaultdict', args, node);
      case 'OrderedDict':
        return this.callModuleFn('collections', 'OrderedDict', args, node);
      case 'heappush':
      case 'heappop':
      case 'heapify':
      case 'heappushpop':
      case 'nlargest':
      case 'nsmallest':
        return this.callModuleFn('heapq', name, args, node);
      default:
        throw this.err(`Unknown function '${name}'`, node);
    }
  }

  hashVal(v) {
    const s = this.repr(v);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return h;
  }

  callModuleFn(mod, fn, args, node) {
    if (mod === 'math') return this.mathFn(fn, args, node);
    if (mod === 'random') return this.randomFn(fn, args, node);
    if (mod === 'heapq') return this.heapqFn(fn, args, node);
    if (mod === 'collections') return this.collectionsFn(fn, args, node);
    throw this.err(`Unknown module function ${mod}.${fn}`, node);
  }

  mathFn(fn, args, node) {
    const n = (...i) => i.map((x) => this.toNum(args[x], node));
    switch (fn) {
      case 'sqrt': return Math.sqrt(n(0)[0]);
      case 'floor': return Math.floor(n(0)[0]);
      case 'ceil': return Math.ceil(n(0)[0]);
      case 'trunc': return Math.trunc(n(0)[0]);
      case 'fabs': return Math.abs(n(0)[0]);
      case 'pow': return Math.pow(n(0)[0], n(1)[0]);
      case 'exp': return Math.exp(n(0)[0]);
      case 'log': return args.length > 1 ? Math.log(n(0)[0]) / Math.log(n(1)[0]) : Math.log(n(0)[0]);
      case 'log2': return Math.log2(n(0)[0]);
      case 'log10': return Math.log10(n(0)[0]);
      case 'sin': return Math.sin(n(0)[0]);
      case 'cos': return Math.cos(n(0)[0]);
      case 'tan': return Math.tan(n(0)[0]);
      case 'asin': return Math.asin(n(0)[0]);
      case 'acos': return Math.acos(n(0)[0]);
      case 'atan': return Math.atan(n(0)[0]);
      case 'atan2': return Math.atan2(n(0)[0], n(1)[0]);
      case 'hypot': return Math.hypot(...args.map((a) => this.toNum(a, node)));
      case 'degrees': return (n(0)[0] * 180) / Math.PI;
      case 'radians': return (n(0)[0] * Math.PI) / 180;
      case 'isnan': return Number.isNaN(n(0)[0]);
      case 'isinf': return !Number.isFinite(n(0)[0]) && !Number.isNaN(n(0)[0]);
      case 'isclose': {
        const [a, b] = n(0, 1);
        const rel = this.currentKwargs?.get('rel_tol') ?? 1e-9;
        const abs = this.currentKwargs?.get('abs_tol') ?? 0;
        return Math.abs(a - b) <= Math.max(Number(rel) * Math.max(Math.abs(a), Math.abs(b)), Number(abs));
      }
      case 'copysign': {
        const [a, b] = n(0, 1);
        return Math.abs(a) * Math.sign(b || 1);
      }
      case 'fmod': return n(0)[0] % n(1)[0];
      case 'gcd': {
        let [a, b] = n(0, 1).map((x) => Math.abs(Math.trunc(x)));
        while (b) [a, b] = [b, a % b];
        return a;
      }
      case 'lcm': {
        const [a, b] = n(0, 1).map((x) => Math.abs(Math.trunc(x)));
        if (!a || !b) return 0;
        let x = a, y = b;
        while (y) [x, y] = [y, x % y];
        return Math.abs(a / x * b);
      }
      case 'factorial': {
        const k = Math.trunc(n(0)[0]);
        if (k < 0) throw this.pyErr('ValueError', 'factorial() not defined for negative values', node);
        let r = 1;
        for (let i = 2; i <= k; i++) r *= i;
        return r;
      }
      case 'comb': {
        const [nn, kk] = n(0, 1).map((x) => Math.trunc(x));
        if (kk < 0 || kk > nn) return 0;
        let r = 1;
        for (let i = 0; i < kk; i++) r = (r * (nn - i)) / (i + 1);
        return Math.round(r);
      }
      case 'perm': {
        const nn = Math.trunc(n(0)[0]);
        const kk = args.length > 1 ? Math.trunc(n(1)[0]) : nn;
        if (kk < 0 || kk > nn) return 0;
        let r = 1;
        for (let i = 0; i < kk; i++) r *= nn - i;
        return r;
      }
      default:
        throw this.err(`math.${fn} is not available`, node);
    }
  }

  randomFn(fn, args, node) {
    switch (fn) {
      case 'seed':
        this.rng = makeRng(args[0] != null ? this.toNum(args[0], node) : 42);
        return null;
      case 'random':
        return this.rng();
      case 'uniform': {
        const a = this.toNum(args[0], node);
        const b = this.toNum(args[1], node);
        return a + (b - a) * this.rng();
      }
      case 'randint': {
        const a = Math.trunc(this.toNum(args[0], node));
        const b = Math.trunc(this.toNum(args[1], node));
        return a + Math.floor(this.rng() * (b - a + 1));
      }
      case 'randrange': {
        const nums = args.map((a) => Math.trunc(this.toNum(a, node)));
        let start = 0, stop, step = 1;
        if (nums.length === 1) stop = nums[0];
        else if (nums.length === 2) [start, stop] = nums;
        else [start, stop, step] = nums;
        const n = Math.ceil((stop - start) / step);
        return start + Math.floor(this.rng() * n) * step;
      }
      case 'choice': {
        const arr = this.iterableToArray(args[0], node);
        if (!arr.length) throw this.pyErr('IndexError', 'Cannot choose from an empty sequence', node);
        return arr[Math.floor(this.rng() * arr.length)];
      }
      case 'shuffle': {
        const obj = this.derefArray(args[0], node);
        for (let i = obj.items.length - 1; i > 0; i--) {
          const j = Math.floor(this.rng() * (i + 1));
          [obj.items[i], obj.items[j]] = [obj.items[j], obj.items[i]];
        }
        return null;
      }
      case 'sample': {
        const arr = [...this.iterableToArray(args[0], node)];
        const k = Math.trunc(this.toNum(args[1], node));
        if (k > arr.length) throw this.pyErr('ValueError', 'sample larger than population', node);
        for (let i = 0; i < k; i++) {
          const j = i + Math.floor(this.rng() * (arr.length - i));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return this.newList(arr.slice(0, k));
      }
      default:
        throw this.err(`random.${fn} is not available`, node);
    }
  }

  heapqFn(fn, args, node) {
    const asHeap = (v) => this.derefArray(v, node);
    switch (fn) {
      case 'heappush': {
        const h = asHeap(args[0]);
        h.items.push(args[1]);
        this.siftUp(h.items, h.items.length - 1, node);
        return null;
      }
      case 'heappop': {
        const h = asHeap(args[0]);
        if (!h.items.length) throw this.pyErr('IndexError', 'index out of range', node);
        const top = h.items[0];
        const last = h.items.pop();
        if (h.items.length) {
          h.items[0] = last;
          this.siftDown(h.items, 0, node);
        }
        return top;
      }
      case 'heapify': {
        const h = asHeap(args[0]);
        for (let i = Math.floor(h.items.length / 2) - 1; i >= 0; i--) this.siftDown(h.items, i, node);
        return null;
      }
      case 'heappushpop': {
        this.heapqFn('heappush', args, node);
        return this.heapqFn('heappop', [args[0]], node);
      }
      case 'nlargest':
      case 'nsmallest': {
        const k = Math.trunc(this.toNum(args[0], node));
        const vals = [...this.iterableToArray(args[1], node)];
        this.sortItems(vals, node);
        if (fn === 'nlargest') vals.reverse();
        return this.newList(vals.slice(0, k));
      }
      default:
        throw this.err(`heapq.${fn} is not available`, node);
    }
  }

  siftUp(a, i, node) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.toNum(a[i], node) >= this.toNum(a[p], node)) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }

  siftDown(a, i, node) {
    const n = a.length;
    for (;;) {
      let s = i;
      const l = i * 2 + 1;
      const r = l + 1;
      if (l < n && this.toNum(a[l], node) < this.toNum(a[s], node)) s = l;
      if (r < n && this.toNum(a[r], node) < this.toNum(a[s], node)) s = r;
      if (s === i) break;
      [a[i], a[s]] = [a[s], a[i]];
      i = s;
    }
  }

  collectionsFn(fn, args, node) {
    switch (fn) {
      case 'deque': {
        const items = args.length ? [...this.iterableToArray(args[0], node)] : [];
        return this.newList(items, 'deque');
      }
      case 'Counter': {
        const entries = [];
        if (args.length) {
          for (const v of this.iterableToArray(args[0], node)) {
            const hit = entries.find(([k]) => this.deepEqual(k, v));
            if (hit) hit[1] += 1;
            else entries.push([v, 1]);
          }
        }
        return this.newDict(entries);
      }
      case 'defaultdict': {
        const factory = args[0] ?? null;
        const d = this.newDict([]);
        const obj = this.ctx.heap.deref(d);
        obj.meta.defaultFactory = factory;
        obj.label = 'defaultdict';
        return d;
      }
      case 'OrderedDict':
        return this.newDict(args.length ? this.iterableToArray(args[0], node).map((p) => {
          const pair = this.iterableToArray(p, node);
          return [pair[0], pair[1]];
        }) : []);
      default:
        throw this.err(`collections.${fn} is not available`, node);
    }
  }
}

const PY_EXC_NAMES = new Set([
  'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError', 'RuntimeError',
  'AssertionError', 'ZeroDivisionError', 'NameError', 'StopIteration',
]);

const PY_BUILTIN_NAMES = new Set([
  'print', 'len', 'range', 'input', 'int', 'float', 'str', 'bool', 'abs', 'round', 'pow',
  'min', 'max', 'sum', 'sorted', 'reversed', 'enumerate', 'zip', 'list', 'tuple', 'set',
  'dict', 'ord', 'chr', 'type', 'map', 'filter', 'any', 'all', 'isinstance', 'divmod',
  'id', 'iter', 'next', 'format',
  ...PY_EXC_NAMES,
]);

/* ============================ entry point ============================ */

export async function runPython(code, ctx) {
  const parser = await getParser('python');
  const tree = parser.parse(code);
  const bad = findSyntaxError(tree.rootNode);
  if (bad) throw new ParseError(`Invalid Python syntax near line ${ln(bad)}`, ln(bad));
  const program = normProgram(tree.rootNode);
  const interp = new PyInterp(ctx);
  ctx.step(program.body[0]?.line ?? 1, 'start', 'Program start');
  for (const stmt of program.body) interp.execStmt(stmt);
  const lastLine = program.body[program.body.length - 1]?.line ?? 1;
  ctx.step(ctx.currentLine ?? lastLine, 'end', 'Program finished');
}
