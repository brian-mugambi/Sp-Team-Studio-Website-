import { useState } from 'react';
import { AmbientField } from './components/AmbientField';
import { BootSequence } from './components/BootSequence';
import { Header } from './components/Header';
import { Hero } from './components/Hero';
import { Philosophy } from './components/Philosophy';
import { Trust } from './components/Trust';
import { Services } from './components/Services';
import { Methodology } from './components/Methodology';
import { Impact } from './components/Impact';
import { Community } from './components/Community';
import { Hosting } from './components/Hosting';
import { FinalCta } from './components/FinalCta';
import { Footer } from './components/Footer';
import { ContactModal } from './components/ContactModal';
import ProfileNetwork from './profile/ProfileNetwork';

function useProfileRoute() {
  const path = window.location.pathname;
  if (path === '/profiles') return { active: true, username: undefined };
  const match = path.match(/^\/profile\/([^/]+)\/?$/);
  if (match) return { active: true, username: decodeURIComponent(match[1]) };
  return { active: false, username: undefined };
}

export default function App() {
  const [booted, setBooted] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const route = useProfileRoute();

  if (route.active) {
    return <ProfileNetwork username={route.username} />;
  }

  return (
    <>
      <AmbientField />
      <BootSequence onDone={() => setBooted(true)} />
      <div className={booted ? 'site-ready' : ''}>
        <Header />
        <Hero onContact={() => setContactOpen(true)} />
        <Philosophy />
        <Trust />
        <Services />
        <Methodology />
        <Impact />
        <Community />
        <Hosting />
        <FinalCta onContact={() => setContactOpen(true)} />
        <Footer />
      </div>
      <ContactModal open={contactOpen} onClose={() => setContactOpen(false)} />
    </>
  );
}
