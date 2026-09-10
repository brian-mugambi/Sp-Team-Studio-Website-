import type { ReactNode } from 'react';
import { useReveal } from '../hooks/useReveal';

/** h2 with the clip-path "mask" reveal animation, triggered on scroll-into-view. */
export function SectionHeading({ children }: { children: ReactNode }) {
  const { ref, visible } = useReveal<HTMLHeadingElement>();
  return (
    <h2 ref={ref} className={visible ? 'is-visible' : ''}>
      <span className="heading-mask">{children}</span>
    </h2>
  );
}
