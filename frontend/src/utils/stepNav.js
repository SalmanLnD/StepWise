/** Find the step index for Step Over from `i` (skip callee frames). */
export function findStepOverIndex(steps, i) {
  if (!steps?.length || i >= steps.length - 1) return i;
  const depth = steps[i].frames.length;
  const next = steps[i + 1];
  if (!next || next.frames.length <= depth) return i + 1;
  for (let j = i + 1; j < steps.length; j++) {
    if (steps[j].frames.length <= depth) return j;
  }
  return steps.length - 1;
}

/** Find the step index for Step Out (leave current frame). */
export function findStepOutIndex(steps, i) {
  if (!steps?.length || i >= steps.length - 1) return i;
  const depth = steps[i].frames.length;
  if (depth <= 1) return findStepOverIndex(steps, i);
  for (let j = i + 1; j < steps.length; j++) {
    if (steps[j].frames.length < depth) return j;
  }
  return steps.length - 1;
}
