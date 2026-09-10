import { SectionPrompt } from './SectionPrompt';
import { SectionHeading } from './SectionHeading';
import { FlowItem } from './FlowItem';

export function Services() {
  return (
    <section className="spts-section" id="services">
      <SectionPrompt text="SPTS::SERVICES" />
      <SectionHeading>
        Core <span className="highlight">services</span>
      </SectionHeading>
      <p className="section-lead">
        We offer a comprehensive suite of digital capabilities designed to take your brand from
        concept to market dominance.
      </p>

      <div className="flow-list">
        <FlowItem icon="fas fa-code" title="Full-Stack Engineering" tag="REACT · NODE · PYTHON">
          Secure, maintainable websites and applications built with modern frameworks and
          established development practices, from initial releases to larger platforms.
        </FlowItem>
        <FlowItem
          icon="fas fa-pen-ruler"
          title="Interface Architecture"
          tag="FIGMA · PROTOTYPING · UX RESEARCH"
          delay={90}
        >
          Clear, accessible UI/UX designed around user needs, business requirements, and
          straightforward navigation.
        </FlowItem>
        <FlowItem
          icon="fas fa-chart-simple"
          title="Digital Performance"
          tag="SEO · CORE VITALS · ANALYTICS"
          delay={180}
        >
          Technical SEO, performance improvements, and analytics setup that help you monitor
          visibility, usability, and business performance.
        </FlowItem>
      </div>
    </section>
  );
}
