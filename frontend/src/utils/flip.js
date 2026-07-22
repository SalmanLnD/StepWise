import { useLayoutEffect, useRef } from 'react';

/**
 * FLIP animation hook: children of `containerRef` carrying data-flip-key
 * animate smoothly from their previous positions whenever `depKey` changes.
 */
export function useFlip(containerRef, depKey) {
  const prevRects = useRef(new Map());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const els = container.querySelectorAll('[data-flip-key]');
    const newRects = new Map();
    for (const el of els) {
      const key = el.dataset.flipKey;
      const rect = el.getBoundingClientRect();
      newRects.set(key, rect);
      const prev = prevRects.current.get(key);
      if (prev) {
        const dx = prev.left - rect.left;
        const dy = prev.top - rect.top;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
          el.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
            { duration: 380, easing: 'cubic-bezier(0.34, 1.3, 0.5, 1)' }
          );
        }
      }
    }
    prevRects.current = newRects;
  }, [depKey, containerRef]);
}

/** Assign stable-ish flip keys to array values: value + duplicate occurrence. */
export function flipKeys(items, fmt) {
  const seen = new Map();
  return items.map((v) => {
    const base = fmt(v);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  });
}
