import { useEffect, useRef } from 'react';
import { useCanHover, useReducedMotion } from './useMediaQuery';

interface Options {
  tilt?: boolean;
}

/**
 * Tracks pointer position over an element as CSS custom properties
 * (--mx, --my) for a radial glow, and optionally applies a subtle 3D tilt.
 * Replaces the old card spotlight/tilt mousemove handlers.
 */
export function usePointerGlow<T extends HTMLElement>({ tilt = false }: Options = {}) {
  const ref = useRef<T | null>(null);
  const reduceMotion = useReducedMotion();
  const canHover = useCanHover();

  useEffect(() => {
    const el = ref.current;
    if (!el || reduceMotion || !canHover) return;

    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      el.style.setProperty('--mx', `${(x / r.width) * 100}%`);
      el.style.setProperty('--my', `${(y / r.height) * 100}%`);
      if (tilt) {
        const rx = ((y / r.height) - 0.5) * -6;
        const ry = ((x / r.width) - 0.5) * 6;
        el.style.transform = `perspective(700px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-2px)`;
      }
    };
    const onLeave = () => {
      if (tilt) el.style.transform = '';
    };

    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseleave', onLeave);
    return () => {
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseleave', onLeave);
    };
  }, [reduceMotion, canHover, tilt]);

  return ref;
}
