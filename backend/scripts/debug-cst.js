import { getParser } from '../src/engine/parser-host.js';

const parser = await getParser('python');
const tree = parser.parse('x = a <= 1\ny = b is not None\n');

function dump(node, depth = 0) {
  const named = node.isNamed ? '' : ' (anon)';
  console.log('  '.repeat(depth) + node.type + named + ' :: ' + JSON.stringify(node.text.slice(0, 30)));
  for (let i = 0; i < node.childCount; i++) dump(node.child(i), depth + 1);
}
dump(tree.rootNode);

const cmp = tree.rootNode.descendantsOfType('comparison_operator')[0];
console.log('childCount', cmp.childCount, 'children:', cmp.children.map((c) => c && c.type));
