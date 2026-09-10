import { SectionPrompt } from './SectionPrompt';
import { SectionHeading } from './SectionHeading';
import { Reveal } from './Reveal';
import { useCounter } from '../hooks/useCounter';

const STATS = [
  { target: 2.5, decimals: 1, suffix: 'x', label: 'Reported conversion improvement' },
  { target: 0.8, decimals: 1, suffix: 's', label: 'Average page load time' },
  { target: 98, decimals: 0, suffix: '%', label: 'Client satisfaction' },
  { target: 72, decimals: 0, suffix: 'h', label: 'Average deployment time' },
];

function StatEntry({ target, decimals, suffix, label, delay }: (typeof STATS)[number] & { delay: number }) {
  const { ref, value } = useCounter<HTMLDivElement>({ target, decimals, suffix });
  return (
    <Reveal className="stat-entry" delay={delay}>
      <div className="stat-num" ref={ref}>
        {value}
      </div>
      <p>{label}</p>
    </Reveal>
  );
}

export function Impact() {
  return (
    <section className="spts-section" id="results">
      <SectionPrompt text="SPTS::IMPACT" />
      <SectionHeading>
        What our <span className="highlight">clients can expect</span>
      </SectionHeading>

      <div className="stat-field">
        {STATS.map((stat, i) => (
          <StatEntry key={stat.label} {...stat} delay={i * 80} />
        ))}
      </div>
    </section>
  );
}
