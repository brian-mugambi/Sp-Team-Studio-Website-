import { SectionPrompt } from './SectionPrompt';
import { SectionHeading } from './SectionHeading';
import { Reveal } from './Reveal';

const WHATSAPP_URL = 'https://chat.whatsapp.com/CZoP0RCjCEGEfJUDTARAvU?s=cl&p=a&mlu=4&ilr=4';

export function Community() {
  return (
    <section className="spts-section" id="vibe-skill">
      <SectionPrompt text="SPTS::COMMUNITY" />
      <SectionHeading>
        Vibe <span className="highlight">Skill</span> · digital learning initiative
      </SectionHeading>

      <Reveal className="community-flow">
        <div className="community-badge">Professional development</div>
        <div className="community-media">
          <img src="/vibe.jpg" alt="Vibe Skill Community — accessible digital skills education" />
        </div>
        <p className="community-lead">
          SP Team Studio maintains <span className="accent">Vibe Skill</span> — a community
          initiative dedicated to practical digital skills development.
        </p>
        <p className="community-body">
          Professionals and learners collaborate on real-world projects, exchange insights, and
          build capabilities in web engineering, interface design, and digital strategy.
        </p>
        <p className="community-note">
          <i className="fas fa-graduation-cap" />
          By investing in community education, we ensure our team stays at the cutting edge and
          our clients benefit from the latest digital practices.
        </p>
        <a
          href={WHATSAPP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="spts-btn primary vibe-join-btn"
        >
          <i className="fab fa-whatsapp" /> JOIN THE COMMUNITY
        </a>
      </Reveal>
    </section>
  );
}
