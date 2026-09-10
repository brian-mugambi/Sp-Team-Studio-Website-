import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../hooks/useMediaQuery';

const LINES = [
  'initializing spts_core...',
  'loading modules: engineering, design, strategy...',
  'establishing secure connection...',
  'access granted.',
];

/** One-time terminal boot animation, skipped on repeat visits within a session. */
export function BootSequence({ onDone }: { onDone: () => void }) {
  const reduceMotion = useReducedMotion();
  const [lines, setLines] = useState<string[]>([]);
  const [fillPct, setFillPct] = useState(0);
  const [hidden, setHidden] = useState(false);
  const finishedRef = useRef(false);

  useEffect(() => {
    let alreadyBooted = false;
    try {
      alreadyBooted = sessionStorage.getItem('sptsBooted') === '1';
    } catch {
      /* sessionStorage unavailable — treat as not booted */
    }

    if (alreadyBooted || reduceMotion) {
      finishedRef.current = true;
      setHidden(true);
      onDone();
      return;
    }

    const timeouts: ReturnType<typeof setTimeout>[] = [];
    let i = 0;

    const finish = () => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      setHidden(true);
      try {
        sessionStorage.setItem('sptsBooted', '1');
      } catch {
        /* ignore */
      }
      onDone();
    };

    const addLine = () => {
      if (i >= LINES.length) {
        timeouts.push(setTimeout(finish, 400));
        return;
      }
      setLines((prev) => [...prev, LINES[i]]);
      setFillPct(Math.round(((i + 1) / LINES.length) * 100));
      i++;
      timeouts.push(setTimeout(addLine, 380));
    };

    timeouts.push(setTimeout(addLine, 200));
    timeouts.push(setTimeout(finish, 5000)); // safety net

    return () => timeouts.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  return (
    <div className={`boot-sequence${hidden ? ' hidden' : ''}`} id="bootSequence">
      <div className="boot-terminal">
        <div className="boot-label">SPTS::BOOT</div>
        <div className="boot-lines">
          {lines.map((line, idx) => (
            <div className={`line${idx === LINES.length - 1 ? ' ok' : ''}`} key={line}>
              <span className="cyan">&gt;</span> {line}
            </div>
          ))}
        </div>
        <div className="boot-bar">
          <div className="boot-bar-fill" style={{ width: `${fillPct}%` }} />
        </div>
      </div>
    </div>
  );
}
