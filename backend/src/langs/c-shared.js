import { ParseError } from '../engine/errors.js';

/**
 * Shared CST normalization helpers for the C and C++ front-ends
 * (tree-sitter-c and tree-sitter-cpp have nearly identical shapes).
 *
 * ctype: { base: 'int'|'float'|'double'|'char'|'bool'|'void'|'long'|
 *          'struct:Name'|'class:Name'|'vector'|'string'|'auto'...,
 *          ptr: number, elem?: ctype (vector element) }
 */

export const ln = (node) => node.startPosition.row + 1;

export const isNamed = (n) => (typeof n.isNamed === 'function' ? n.isNamed() : n.isNamed);

export function parseType(n) {
  if (!n) return { base: 'int', ptr: 0 };
  switch (n.type) {
    case 'primitive_type':
      return { base: n.text === 'size_t' ? 'int' : n.text, ptr: 0 };
    case 'sized_type_specifier': {
      const t = n.text;
      if (t.includes('char')) return { base: 'char', ptr: 0 };
      if (t.includes('double')) return { base: 'double', ptr: 0 };
      return { base: 'int', ptr: 0 };
    }
    case 'struct_specifier':
    case 'class_specifier': {
      const name = n.childForFieldName('name')?.text;
      return { base: 'struct:' + (name ?? '?'), ptr: 0 };
    }
    case 'type_identifier':
      return { base: 'named:' + n.text, ptr: 0 };
    case 'template_type': {
      const name = n.childForFieldName('name').text;
      const args = n.childForFieldName('arguments');
      const inner = [];
      for (const a of args.namedChildren) {
        if (a.type === 'type_descriptor') inner.push(parseType(a.childForFieldName('type')));
        else inner.push(parseType(a));
      }
      return { base: name, ptr: 0, targs: inner };
    }
    case 'qualified_identifier': {
      // std::vector<int>, std::string
      const name = n.childForFieldName('name');
      return parseType(name);
    }
    case 'type_descriptor':
      return applyAbstractDeclarators(parseType(n.childForFieldName('type')), n.childForFieldName('declarator'));
    case 'auto':
      return { base: 'auto', ptr: 0 };
    default:
      return { base: n.text, ptr: 0 };
  }
}

function applyAbstractDeclarators(ctype, decl) {
  let t = { ...ctype };
  while (decl) {
    if (decl.type === 'abstract_pointer_declarator' || decl.type === 'pointer_declarator') {
      t.ptr++;
      decl = decl.childForFieldName('declarator');
    } else break;
  }
  return t;
}

/**
 * Unwrap a declarator chain returning { name, ptr, dims, params, isRef }.
 * dims: array of expression CST nodes (or null for unsized []).
 */
export function unwrapDeclarator(decl) {
  let ptr = 0;
  const dims = [];
  let isRef = false;
  let params = null;
  let name = null;
  let node = decl;
  while (node) {
    switch (node.type) {
      case 'pointer_declarator':
        ptr++;
        node = node.childForFieldName('declarator');
        break;
      case 'reference_declarator':
        isRef = true;
        node = node.namedChildren[0];
        break;
      case 'array_declarator': {
        dims.push(node.childForFieldName('size') ?? null);
        node = node.childForFieldName('declarator');
        break;
      }
      case 'function_declarator':
        params = node.childForFieldName('parameters');
        node = node.childForFieldName('declarator');
        break;
      case 'parenthesized_declarator':
        node = node.namedChildren[0];
        break;
      case 'init_declarator':
        node = node.childForFieldName('declarator');
        break;
      case 'identifier':
      case 'field_identifier':
      case 'type_identifier':
      case 'destructor_name':
        name = node.text;
        node = null;
        break;
      case 'qualified_identifier':
        name = node.childForFieldName('name').text;
        node = null;
        break;
      default:
        name = node.text;
        node = null;
    }
  }
  return { name, ptr, dims, params, isRef };
}

export function unescapeC(raw) {
  // strip surrounding quotes then process escapes
  let s = raw;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.replace(/\\(n|t|r|0|\\|'|")/g, (_, c) =>
    c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c === '0' ? '\0' : c
  );
}

export function parseNumber(text) {
  const t = text.replace(/[uUlLfF]+$/, '');
  if (/^0[xX]/.test(t)) return parseInt(t, 16);
  if (/^0[bB]/.test(t)) return parseInt(t.slice(2), 2);
  if (t.includes('.') || t.includes('e') || t.includes('E')) return parseFloat(t);
  return parseInt(t, 10);
}

export function unsupported(n, lang) {
  return new ParseError(`Unsupported ${lang} construct: ${n.type.replace(/_/g, ' ')}`, ln(n));
}
