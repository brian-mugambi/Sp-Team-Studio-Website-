import { SectionPrompt } from './SectionPrompt';
import { useTypewriterRotator } from '../hooks/useTypewriterRotator';

const ROTATOR_PHRASES = [
  'We solve business problems, not just build websites.',
  'We architect systems that hold up under real usage.',
  'We turn unclear requirements into shipped products.',
  'We find the bottleneck and remove it.',
];

export function Hero({ onContact }: { onContact: () => void }) {
  const rotatorText = useTypewriterRotator(ROTATOR_PHRASES);

  return (
    <section className="spts-hero">
      <SectionPrompt text="SPTS::OVERVIEW" variant="hero" />
      <h1>
        <span className="highlight">SP Team Studio</span>
        <span className="cursor" />
      </h1>
      <div className="hero-rotator">
        <span className="rotator-prefix">&gt;_</span>
        <span className="rotator-text">{rotatorText}</span>
      </div>
      <p>
        Digital platforms and systems built to support measurable business objectives.
        <br />
        <span className="hero-sub">
          We architect, build, and deploy digital systems that position brands for sustained
          market leadership.
        </span>
      </p>
      <div className="cta-group">
        <button className="spts-btn primary" onClick={onContact}>
          <i className="fas fa-envelope" /> INITIATE CONSULTATION
        </button>
        <a href="#services" className="spts-btn">
          <i className="fas fa-arrow-down" /> EXPLORE CAPABILITIES
        </a>
      </div>
      <div className="trust-indicators">
        <span>
          <i className="fas fa-check-circle" /> Custom development
        </span>
        <span>
          <i className="fas fa-check-circle" /> Purpose-built solutions
        </span>
        <span>
          <i className="fas fa-check-circle" /> Dedicated project management
        </span>
      </div>
    </section>
  );
}
