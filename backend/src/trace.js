import { ExecContext } from './engine/context.js';
import { StepwiseError } from './engine/errors.js';
import { resetIds } from './engine/values.js';
import { runPython } from './langs/python.js';
import { runC } from './langs/c.js';
import { runCpp } from './langs/cpp.js';
import { runJava } from './langs/java.js';

const runners = { python: runPython, c: runC, cpp: runCpp, java: runJava };

export async function trace(language, code, stdin = '') {
  resetIds();
  const ctx = new ExecContext(language, { stdin });
  try {
    await runners[language](code, ctx);
    return ctx.result(null);
  } catch (e) {
    if (e instanceof StepwiseError || e?.stepwiseLimit) {
      const err = e instanceof StepwiseError ? e : new StepwiseError(e.message, ctx.currentLine, 'LimitExceeded');
      ctx.step(err.line ?? ctx.currentLine ?? 1, 'exception', err.message);
      return ctx.result(err);
    }
    // real engine bug — surface as generic runtime error but log it
    console.error('[engine bug]', e);
    const err = new StepwiseError('Engine error: ' + e.message, ctx.currentLine, 'EngineError');
    ctx.step(ctx.currentLine ?? 1, 'exception', err.message);
    return ctx.result(err);
  }
}
