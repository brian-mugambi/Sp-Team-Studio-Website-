import { Reveal } from './Reveal';
import { SectionHeading } from './SectionHeading';

export function FinalCta({ onContact }: { onContact: () => void }) {
  return (
    <section className="spts-section" id="final-cta">
      <Reveal className="final-cta-flow">
        <div className="section-prompt final-cta-prompt">SPTS::NEXT STEP</div>
        <SectionHeading>
          Have a <span className="highlight">project in mind?</span>
        </SectionHeading>
        <p className="section-lead">
          Whether you&apos;re launching a new venture or scaling an existing brand, we&apos;re
          ready to help you build digital systems that deliver real results.
        </p>
        <button className="spts-btn primary final-cta-btn" onClick={onContact}>
          <i className="fas fa-envelope" /> REQUEST A CONSULTATION
        </button>
        <p className="final-cta-note">
          <i className="fas fa-lock" />
          No obligation · Clear scope · Practical advice
        </p>
      </Reveal>
    </section>
  );
}
