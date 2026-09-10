import { useEffect, useState } from 'react';
import { useReducedMotion } from './useMediaQuery';

const TYPE_SPEED = 35;
const DELETE_SPEED = 20;
const HOLD = 1800;
const GAP = 400;

/** Types, holds, then deletes each phrase in a loop — mirrors the original hero rotator. */
export function useTypewriterRotator(phrases: string[]) {
  const reduceMotion = useReducedMotion();
  const [text, setText] = useState(reduceMotion ? phrases[0] ?? '' : '');

  useEffect(() => {
    if (reduceMotion || phrases.length === 0) {
      setText(phrases[0] ?? '');
      return;
    }

    let i = 0;
    let char = 0;
    let deleting = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    const loop = () => {
      const current = phrases[i];
      if (!deleting) {
        char++;
        setText(current.slice(0, char));
        if (char === current.length) {
          timeoutId = setTimeout(() => {
            deleting = true;
            loop();
          }, HOLD);
          return;
        }
        timeoutId = setTimeout(loop, TYPE_SPEED);
      } else {
        char--;
        setText(current.slice(0, char));
        if (char === 0) {
          deleting = false;
          i = (i + 1) % phrases.length;
          timeoutId = setTimeout(loop, GAP);
          return;
        }
        timeoutId = setTimeout(loop, DELETE_SPEED);
      }
    };

    loop();
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  return text;
}
