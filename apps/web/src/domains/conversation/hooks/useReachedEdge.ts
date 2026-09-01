import { useCallback, useEffect, useRef } from 'react';

/**
 * Calls back when an element comes into view, which is how "there is more, and
 * you have reached it" is asked without a button. A scroll listener would answer
 * the same question by running on every frame and measuring the layout; an
 * observer is told by the browser instead.
 *
 * `enabled` rather than a conditional call, so the sentinel keeps its place in
 * the tree while there is nothing left to load.
 */
export function useReachedEdge(
  enabled: boolean,
  onReach: () => void,
): (node: Element | null) => void {
  const reach = useRef(onReach);
  const observer = useRef<IntersectionObserver | null>(null);

  // Kept current in an effect rather than during the render: a render is a
  // description of what to draw, and writing to a ref in the middle of one is a
  // side effect React is free to run twice.
  useEffect(() => {
    reach.current = onReach;
  }, [onReach]);

  useEffect(
    () => () => {
      observer.current?.disconnect();
    },
    [],
  );

  // A callback ref rather than an object one: it fires when the node arrives and
  // again when it leaves, which is exactly when the observer has to be rebuilt.
  return useCallback(
    (node: Element | null) => {
      observer.current?.disconnect();
      // Absent in a server render and in jsdom. A page that cannot observe
      // still shows every message it has; it just stops loading more on its own.
      if (node === null || !enabled || typeof IntersectionObserver === 'undefined') return;

      observer.current = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) reach.current();
      });
      observer.current.observe(node);
    },
    [enabled],
  );
}
