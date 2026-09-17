export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="spts-footer">
      <div className="spts-footer-content">
        <div>
          <div className="footer-logo">
            <span className="bracket">[</span>
            <span className="footer-logo-white">SPTS</span>
            <span className="bracket">]</span>
          </div>
          <p className="footer-tagline">Digital Strategy &amp; Engineering</p>
          <a href="/profiles" className="footer-link">
            <i className="fas fa-user" /> Create your profile
          </a>
        </div>
        <div className="footer-right">
          <p className="footer-year">{year} · SP Team Studio</p>
          <p className="footer-icon">
            <i className="fas fa-terminal" />
          </p>
        </div>
      </div>
    </footer>
  );
}
