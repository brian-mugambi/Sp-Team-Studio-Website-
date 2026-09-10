import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useReducedMotion } from './useMediaQuery';

/**
 * Replaces the vanilla `.reveal` / IntersectionObserver logic.
 * Attach the returned ref to any element; `visible` flips true once
 * the element enters the viewport (or immediately if motion is reduced).
 */
export function useReveal<T extends HTMLElement>(delayMs = 0) {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (reduceMotion || !('IntersectionObserver' in window)) {
      setVisible(true);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setVisible(true);
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduceMotion]);

  const style = {
    '--reveal-delay': `${reduceMotion ? 0 : delayMs}ms`,
  } as CSSProperties;

  return { ref, visible, style };
}
