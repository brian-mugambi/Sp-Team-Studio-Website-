import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from './useMediaQuery';

const SCRAMBLE_CHARS = '!<>-_\\/[]{}=+*^?#01';

/** Scrambles then decodes `text` into place once it scrolls into view. */
export function useDecodeText<T extends HTMLElement>(text: string) {
  const ref = useRef<T | null>(null);
  const reduceMotion = useReducedMotion();
  const [display, setDisplay] = useState(text);

  useEffect(() => {
    const el = ref.current;
    if (!el || reduceMotion || !('IntersectionObserver' in window)) {
      setDisplay(text);
      return;
    }

    const len = text.length;
    const totalFrames = 16;

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          io.unobserve(entry.target);
          let frame = 0;
          const step = () => {
            const revealCount = Math.floor((frame / totalFrames) * len);
            let out = '';
            for (let i = 0; i < len; i++) {
              if (i < revealCount || text[i] === ' ' || text[i] === ':') out += text[i];
              else out += SCRAMBLE_CHARS[(Math.random() * SCRAMBLE_CHARS.length) | 0];
            }
            setDisplay(out);
            frame++;
            if (frame <= totalFrames) requestAnimationFrame(step);
            else setDisplay(text);
          };
          step();
        });
      },
      { threshold: 0.6 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [text, reduceMotion]);

  return { ref, display };
}
