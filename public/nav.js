/**
 * Lincoln Labs — Shared Navigation
 * Self-injects a top nav bar into any dashboard page.
 * Add to a page with: <script src="/nav.js"></script>
 */
(function () {
  const DASHBOARDS = [
    { label: 'Revenue',    href: '/' },
    { label: 'Marketing',  href: '/dist/marketing/' },
    { label: 'P&L by Lab', href: '/pl-by-lab' },
  ];

  const path = window.location.pathname;

  // Determine active link: longest prefix match
  function isActive(href) {
    if (href === '/') return path === '/' || path === '/index.html';
    return path.startsWith(href);
  }

  // Side padding: marketing body has none, revenue body already has 48px
  const hasPadding = !path.startsWith('/dist/');
  const sidePad = hasPadding ? '0' : '48px';
  const mobileSidePad = hasPadding ? '0' : '16px';

  // ── Styles ────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    body {
      background: #0f0f0e !important;
      color: #e8e6e0;
    }
    #ll-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px ${sidePad};
      margin-bottom: 20px;
      background: #0f0f0e;
      border-bottom: 1px solid #2a2a27;
      font-family: 'DM Mono', monospace;
    }
    #ll-nav .ll-brand {
      display: flex;
      align-items: baseline;
      gap: 10px;
      text-decoration: none;
    }
    #ll-nav .ll-brand-logo {
      height: 30px;
      width: auto;
      display: block;
      flex-shrink: 0;
    }
    #ll-nav .ll-brand-label {
      font-size: 0.6rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #7a7870;
    }
    #ll-nav .ll-links {
      display: flex;
      align-items: center;
      gap: 0;
    }
    #ll-nav .ll-link {
      font-size: 0.68rem;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      text-decoration: none;
      color: #7a7870;
      padding: 4px 16px 4px 0;
      transition: color 0.15s;
      position: relative;
    }
    #ll-nav .ll-link:last-child {
      padding-right: 0;
    }
    #ll-nav .ll-link::after {
      content: '';
      display: block;
      height: 1px;
      background: transparent;
      margin-top: 5px;
      transition: background 0.15s;
    }
    #ll-nav .ll-link:hover {
      color: #e8e6e0;
    }
    #ll-nav .ll-link.ll-active {
      color: #e8e6e0;
    }
    #ll-nav .ll-link.ll-active::after {
      background: #e8e6e0;
    }
    #ll-nav .ll-sep {
      font-size: 0.6rem;
      color: #2a2a27;
      padding: 0 4px 0 0;
      user-select: none;
    }
    @media (max-width: 430px) {
      #ll-nav {
        padding-left: ${mobileSidePad};
        padding-right: ${mobileSidePad};
        margin-bottom: 20px;
      }
      #ll-nav .ll-link {
        font-size: 0.62rem;
        padding-right: 12px;
      }
      #ll-nav .ll-brand-label {
        display: none;
      }
    }
  `;
  document.head.appendChild(style);

  // ── Build nav HTML ─────────────────────────────────────────────────────────
  const nav = document.createElement('nav');
  nav.id = 'll-nav';

  // Brand
  const brand = document.createElement('a');
  brand.href = '/';
  brand.className = 'll-brand';
  brand.innerHTML = `
    <img src="/images/ll-logo-white.png" alt="Lincoln Labs" class="ll-brand-logo">
    <span class="ll-brand-label">Lincoln Labs</span>
  `;
  nav.appendChild(brand);

  // Links
  const links = document.createElement('div');
  links.className = 'll-links';
  DASHBOARDS.forEach((d, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'll-sep';
      sep.textContent = '/';
      links.appendChild(sep);
    }
    const a = document.createElement('a');
    a.href = d.href;
    a.className = 'll-link' + (isActive(d.href) ? ' ll-active' : '');
    a.textContent = d.label;
    links.appendChild(a);
  });
  nav.appendChild(links);

  // ── Inject ─────────────────────────────────────────────────────────────────
  // Prepend to body, or insert before first child
  if (document.body.firstChild) {
    document.body.insertBefore(nav, document.body.firstChild);
  } else {
    document.body.appendChild(nav);
  }
})();
