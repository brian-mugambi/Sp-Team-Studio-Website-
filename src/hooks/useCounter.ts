import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from './useMediaQuery';

interface CounterOptions {
  target: number;
  decimals?: number;
  suffix?: string;
  duration?: number;
}

/** Counts up from 0 to target once the element scrolls into view. */
export function useCounter<T extends HTMLElement>({
  target,
  decimals = 0,
  suffix = '',
  duration = 1200,
}: CounterOptions) {
  const ref = useRef<T | null>(null);
  const reduceMotion = useReducedMotion();
  const [value, setValue] = useState(() => (reduceMotion ? target.toFixed(decimals) + suffix : '0' + suffix));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (reduceMotion || !('IntersectionObserver' in window)) {
      setValue(target.toFixed(decimals) + suffix);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          io.unobserve(entry.target);
          let start: number | null = null;
          const tick = (ts: number) => {
            if (start === null) start = ts;
            const p = Math.min(1, (ts - start) / duration);
            const eased = 1 - Math.pow(1 - p, 3);
            setValue((target * eased).toFixed(decimals) + suffix);
            if (p < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      },
      { threshold: 0.5 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [target, decimals, suffix, duration, reduceMotion]);

  return { ref, value };
}
