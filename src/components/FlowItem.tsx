import type { ReactNode } from 'react';
import { Reveal } from './Reveal';
import { usePointerGlow } from '../hooks/usePointerGlow';

interface FlowItemProps {
  icon: string;
  title: string;
  children: ReactNode;
  tag?: string;
  delay?: number;
}

/**
 * A single flowing entry: glowing orb marker + title + copy + optional tag.
 * No border, no background panel — items are separated by a hairline
 * gradient thread rather than boxed into cards.
 */
export function FlowItem({ icon, title, children, tag, delay = 0 }: FlowItemProps) {
  const glowRef = usePointerGlow<HTMLDivElement>();

  return (
    <Reveal className="flow-item" delay={delay}>
      <div className="flow-item-inner" ref={glowRef}>
        <div className="flow-orb">
          <i className={icon} />
        </div>
        <div className="flow-body">
          <h3>{title}</h3>
          <p>{children}</p>
          {tag && <span className="tag">{tag}</span>}
        </div>
      </div>
    </Reveal>
  );
}
