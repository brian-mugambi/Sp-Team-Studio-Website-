import { SectionPrompt } from './SectionPrompt';
import { SectionHeading } from './SectionHeading';
import { Reveal } from './Reveal';

const HOSTING_ITEMS = [
  { icon: 'fas fa-calendar-alt', label: 'Event websites' },
  { icon: 'fas fa-bullhorn', label: 'Campaign landing pages' },
  { icon: 'fas fa-poll', label: 'Survey & data collection' },
  { icon: 'fas fa-birthday-cake', label: 'Personal celebration sites' },
  { icon: 'fas fa-diagram-project', label: 'Microsites' },
  { icon: 'fas fa-flag', label: 'Organization & community pages' },
];

export function Hosting() {
  return (
    <section className="spts-section" id="hosting">
      <SectionPrompt text="SPTS::HOSTING" />
      <SectionHeading>
        Flexible <span className="highlight">hosting solutions</span>
      </SectionHeading>
      <p className="section-lead">
        Not every project requires long-term infrastructure. We provide efficient,
        production-ready hosting for initiatives that need speed and reliability without the
        overhead.
      </p>

      <Reveal className="community-flow">
        <div className="community-badge">Production ready</div>
        <h3 className="hosting-title">
          <i className="fas fa-cloud" /> Firebase &amp; subdomain infrastructure
        </h3>
        <p className="community-body">
          Suitable for <span className="accent-white">short-term, campaign-based, and transitional projects:</span>
        </p>

        <ul className="hosting-flow">
          {HOSTING_ITEMS.map((item, i) => (
            <Reveal as="li" key={item.label} delay={i * 60}>
              <i className={item.icon} />
              <span>{item.label}</span>
            </Reveal>
          ))}
        </ul>

        <p className="hosting-footnote">
          <i className="fas fa-check-circle" />
          Subdomain options · rapid deployment · reliable infrastructure
        </p>
      </Reveal>
    </section>
  );
}
