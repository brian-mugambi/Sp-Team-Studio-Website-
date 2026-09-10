import { useEffect, useState } from 'react';

interface ContactModalProps {
  open: boolean;
  onClose: () => void;
}

const FORM_ACTION = 'https://formsubmit.co/af02cbe99149c37059b8327b329a776c';

/**
 * The consultation request modal: a welcome/intro view that expands into the
 * contact form. Submission posts to formsubmit.co, matching the original site.
 */
export function ContactModal({ open, onClose }: ContactModalProps) {
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
      const t = setTimeout(() => setShowForm(false), 250);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  return (
    <div
      className={`spts-modal-overlay${open ? ' active' : ''}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="spts-modal-card">
        <button className="spts-close-btn" aria-label="Close form" onClick={onClose}>
          <i className="fas fa-times" />
        </button>

        {!showForm && (
          <div className="spts-welcome">
            <div className="spts-prompt">SPTS::CONTACT</div>
            <h2>
              <span className="highlight">SP Team Studio</span>
              <span className="spts-terminal-cursor" />
            </h2>
            <p>Let&apos;s discuss your project requirements.</p>
            <p className="spts-welcome-sub">Websites · digital systems · performance</p>
            <div className="spts-tagline">
              <span>WEB</span>
              <span>DEV</span>
              <span>UI/UX</span>
              <span>SEO</span>
              <span>HOSTING</span>
            </div>
            <p className="spts-welcome-note">
              <i className="fas fa-check-circle" />
              Response within one business day
            </p>
          </div>
        )}

        {!showForm && (
          <div className="spts-actions">
            <button className="spts-action-btn primary" onClick={() => setShowForm(true)}>
              <i className="fas fa-envelope" /> CONTACT
            </button>
          </div>
        )}

        <div className={`spts-form-container${showForm ? ' active' : ''}`}>
          <form className="spts-form" action={FORM_ACTION} method="POST">
            <input type="text" name="_honey" style={{ display: 'none' }} tabIndex={-1} autoComplete="off" />
            <input type="hidden" name="_captcha" value="false" />
            <input type="hidden" name="_template" value="table" />
            <input type="hidden" name="_subject" value="New project inquiry from SPTS portfolio" />

            <div className="spts-form-row">
              <div className="spts-form-group">
                <label htmlFor="sptsName">NAME</label>
                <input type="text" id="sptsName" name="name" placeholder="Your name" required />
              </div>
              <div className="spts-form-group">
                <label htmlFor="sptsEmail">EMAIL</label>
                <input type="email" id="sptsEmail" name="email" placeholder="you@domain.com" required />
              </div>
            </div>

            <div className="spts-form-group">
              <label htmlFor="sptsMessage">MESSAGE</label>
              <textarea
                id="sptsMessage"
                name="message"
                placeholder="Tell us about your project, objectives, and requirements..."
                required
              />
            </div>

            <button type="submit" className="spts-submit-btn">
              <i className="fas fa-paper-plane" /> SEND MESSAGE
            </button>
          </form>

          <button className="spts-back-link" onClick={() => setShowForm(false)}>
            <i className="fas fa-arrow-left" /> BACK
          </button>
        </div>
      </div>
    </div>
  );
}
