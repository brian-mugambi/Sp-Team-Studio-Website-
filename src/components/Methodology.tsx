import { SectionPrompt } from './SectionPrompt';
import { SectionHeading } from './SectionHeading';
import { Reveal } from './Reveal';

const STEPS = [
  {
    n: '01',
    icon: 'fas fa-search',
    title: 'Diagnostic phase',
    body: 'We review your objectives, audience, existing systems, and technical requirements before recommending an approach.',
  },
  {
    n: '02',
    icon: 'fas fa-cut',
    title: 'Strategic reduction',
    body: 'We prioritize the requirements that matter most, remove unnecessary complexity, and establish a clear scope for delivery.',
  },
  {
    n: '03',
    icon: 'fas fa-arrows-to-circle',
    title: 'Focused execution',
    body: 'We implement the agreed solution with attention to usability, performance, reliability, and measurable business requirements.',
  },
  {
    n: '04',
    icon: 'fas fa-chart-bar',
    title: 'Measured iteration',
    body: 'After launch, we review performance, address issues, and make improvements based on actual usage and business needs.',
  },
];

export function Methodology() {
  return (
    <section className="spts-section" id="focus-strategy">
      <SectionPrompt text="SPTS::METHODOLOGY" />
      <SectionHeading>
        How we <span className="highlight">work</span>
      </SectionHeading>
      <p className="section-lead">
        Our process is structured, transparent, and designed to deliver predictable results.
        Here&apos;s what working with us looks like.
      </p>

      <Reveal className="process-frame">
        <div className="process-badge">Strategic framework</div>
        <p className="process-statement">
          <strong>We focus on business outcomes, not simply deliverables.</strong>
        </p>

        <div className="process-spine">
          {STEPS.map((step, i) => (
            <Reveal as="div" className="process-step" delay={i * 90} key={step.n}>
              <span className="process-num">{step.n}</span>
              <div className="process-step-body">
                <i className={step.icon} />
                <h4>{step.title}</h4>
                <p>{step.body}</p>
              </div>
            </Reveal>
          ))}
        </div>

        <p className="process-quote">
          <i className="fas fa-quote-left" />
          Clear requirements and focused execution lead to better digital products.
        </p>
      </Reveal>
    </section>
  );
}
