import type { ElementType, ReactNode, HTMLAttributes } from 'react';
import { useReveal } from '../hooks/useReveal';

interface RevealProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  delay?: number;
  children: ReactNode;
}

/** Fades/slides children in once scrolled into view; used in place of the old `.reveal` class. */
export function Reveal({ as: Tag = 'div', delay = 0, className = '', children, ...rest }: RevealProps) {
  const { ref, visible, style } = useReveal<HTMLElement>(delay);
  return (
    <Tag
      ref={ref}
      className={`reveal${visible ? ' is-visible' : ''}${className ? ' ' + className : ''}`}
      style={style}
      {...rest}
    >
      {children}
    </Tag>
  );
}
