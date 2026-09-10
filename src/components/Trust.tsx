import { SectionPrompt } from './SectionPrompt';
import { SectionHeading } from './SectionHeading';
import { Reveal } from './Reveal';
import { usePointerGlow } from '../hooks/usePointerGlow';

const ITEMS = [
  {
    icon: 'fas fa-shield-halved',
    title: 'Accountability',
    body: 'We take responsibility for the work from initial planning through launch and post-launch support.',
  },
  {
    icon: 'fas fa-clock',
    title: 'Reliability',
    body: 'We work to agreed timelines, communicate progress clearly, and maintain consistent quality throughout development.',
  },
  {
    icon: 'fas fa-handshake',
    title: 'Transparency',
    body: 'We define scope and deliverables clearly and keep you informed about progress, decisions, and any changes.',
  },
  {
    icon: 'fas fa-lightbulb',
    title: 'Strategic thinking',
    body: 'We connect technical decisions to your business goals and build solutions that address practical needs.',
  },
];

function TrustEntry({ icon, title, body, delay }: (typeof ITEMS)[number] & { delay: number }) {
  const glowRef = usePointerGlow<HTMLDivElement>();
  return (
    <Reveal className="trust-entry" delay={delay}>
      <div className="trust-entry-inner" ref={glowRef}>
        <i className={icon} />
        <h4>{title}</h4>
        <p>{body}</p>
      </div>
    </Reveal>
  );
}

export function Trust() {
  return (
    <section className="spts-section" id="trust">
      <SectionPrompt text="SPTS::CREDIBILITY" />
      <SectionHeading>
        Why clients <span className="highlight">work with us</span>
      </SectionHeading>
      <p className="section-lead">
        Trust is earned through consistency, transparency, and results. Here&apos;s what you can
        expect when you partner with SP Team Studio.
      </p>

      <div className="trust-field">
        {ITEMS.map((item, i) => (
          <TrustEntry key={item.title} {...item} delay={i * 80} />
        ))}
      </div>
    </section>
  );
}
