import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Parser = require('web-tree-sitter');
const wasmDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));

await Parser.init();
const lang = await Parser.Language.load(path.join(wasmDir, 'out', 'tree-sitter-python.wasm'));
const parser = new Parser();
parser.setLanguage(lang);
const tree = parser.parse('def f(x):\n    return x + 1\nprint(f(2))\n');
console.log(tree.rootNode.toString().slice(0, 300));

for (const l of ['c', 'cpp', 'java']) {
  const lg = await Parser.Language.load(path.join(wasmDir, 'out', `tree-sitter-${l}.wasm`));
  const p = new Parser();
  p.setLanguage(lg);
  console.log(l, 'ok:', p.parse('int main() { return 0; }').rootNode.type);
}
console.log('OK');
