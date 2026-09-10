import { useDecodeText } from '../hooks/useDecodeText';

/** The "SPTS::WHATEVER" scramble-decode label used above each section heading. */
export function SectionPrompt({ text, variant = 'section' }: { text: string; variant?: 'hero' | 'section' }) {
  const { ref, display } = useDecodeText<HTMLDivElement>(text);
  return (
    <div ref={ref} className={variant === 'hero' ? 'prompt' : 'section-prompt'}>
      {display}
    </div>
  );
}
