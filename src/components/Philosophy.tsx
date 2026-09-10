import { SectionPrompt } from './SectionPrompt';
import { SectionHeading } from './SectionHeading';
import { FlowItem } from './FlowItem';

export function Philosophy() {
  return (
    <section className="spts-section" id="strategy">
      <SectionPrompt text="SPTS::PHILOSOPHY" />
      <SectionHeading>
        The <span className="highlight">value of clarity</span>
      </SectionHeading>
      <p className="section-lead">
        In a digital landscape saturated with noise, the brands that win are those that
        communicate with precision. We believe in building digital experiences that respect your
        audience&apos;s intelligence and time.
      </p>

      <div className="flow-list">
        <FlowItem icon="fas fa-bullseye" title="Purposeful design" tag="CLEAR USER JOURNEYS">
          We remove unnecessary elements and keep each component focused on a clear purpose. The
          result is a simpler experience that helps users find information and take action
          efficiently.
        </FlowItem>
        <FlowItem
          icon="fas fa-gauge-high"
          title="Performance engineering"
          tag="PERFORMANCE OPTIMIZATION"
          delay={90}
        >
          Fast, efficient websites improve usability and support stronger engagement. We use lean
          architecture, optimized assets, and practical performance standards to keep load times
          low.
        </FlowItem>
        <FlowItem
          icon="fas fa-chart-line"
          title="Conversion-focused experiences"
          tag="USER EXPERIENCE"
          delay={180}
        >
          We structure content and interfaces to make key actions clear. Each page is designed to
          help users understand the offer, build confidence, and move to the next step.
        </FlowItem>
      </div>
    </section>
  );
}
