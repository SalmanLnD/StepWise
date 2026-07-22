import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Parser = require('web-tree-sitter');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Vendored grammars — kept in-repo so Vercel serverless includes the .wasm files. */
const wasmDir = path.join(__dirname, '../../wasm');

let initialized = false;
const languages = new Map();
const parsers = new Map();

export async function getParser(lang) {
  if (!initialized) {
    const runtimeWasm = path.join(wasmDir, 'tree-sitter.wasm');
    await Parser.init({
      locateFile(scriptName) {
        if (scriptName === 'tree-sitter.wasm') return runtimeWasm;
        return path.join(wasmDir, scriptName);
      },
    });
    initialized = true;
  }
  if (!parsers.has(lang)) {
    if (!languages.has(lang)) {
      languages.set(lang, await Parser.Language.load(path.join(wasmDir, `tree-sitter-${lang}.wasm`)));
    }
    const p = new Parser();
    p.setLanguage(languages.get(lang));
    parsers.set(lang, p);
  }
  return parsers.get(lang);
}

/** Find the first ERROR/MISSING node for diagnostics. */
export function findSyntaxError(root) {
  if (!root.hasError()) return null;
  let found = null;
  const walk = (node) => {
    if (found) return;
    if (node.type === 'ERROR' || node.isMissing()) {
      found = node;
      return;
    }
    if (!node.hasError()) return;
    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
    if (!found) found = node;
  };
  walk(root);
  return found;
}
