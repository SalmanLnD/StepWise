import { trace } from '../src/trace.js';
import { EXAMPLES } from '../../frontend/src/examples.js';

let failed = 0;
for (const [lang, list] of Object.entries(EXAMPLES)) {
  for (const ex of list) {
    const r = await trace(lang, ex.code, ex.stdin ?? '');
    if (r.ok) {
      console.log(`PASS ${lang}/${ex.id} (${r.stepCount} steps) out=${JSON.stringify(r.stdout.slice(0, 60))}`);
    } else {
      failed++;
      console.log(`FAIL ${lang}/${ex.id}: [${r.error.kind}] line ${r.error.line}: ${r.error.message}`);
    }
  }
}
console.log(failed ? `SUMMARY: ${failed} FAILED` : 'SUMMARY: ALL PASS');
process.exitCode = failed ? 1 : 0;
