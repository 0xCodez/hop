(() => {
  const RELEASES = 'https://github.com/0xCodez/hop/releases/latest/download/';
  const MAC_URL = { arm64: `${RELEASES}Hop-mac-arm64.dmg`, x64: `${RELEASES}Hop-mac-x64.dmg` };

  // ---------- Which computer is this? ----------
  // ?os=mac or ?os=win overrides detection, handy for checking both layouts.
  function detectOS() {
    const forced = new URLSearchParams(location.search).get('os');
    if (forced === 'mac' || forced === 'win') return forced;
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    const ua = navigator.userAgent;
    // iPads report a Mac platform; touch points give them away.
    if (/Mac/i.test(platform) && navigator.maxTouchPoints <= 1) return 'mac';
    if (/Win/i.test(platform) || /Windows NT/.test(ua)) return 'win';
    return null;
  }

  // Only Chromium exposes the CPU architecture. Elsewhere we can't tell, so we offer Apple silicon
  // (what every Mac since 2020 ships with) and keep the Intel link right next to it.
  async function detectMacArch() {
    const forced = new URLSearchParams(location.search).get('arch');
    if (forced === 'arm64' || forced === 'x64') return forced;
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        const { architecture } = await navigator.userAgentData.getHighEntropyValues(['architecture']);
        if (architecture === 'arm') return 'arm64';
        if (architecture === 'x86') return 'x64';
      }
    } catch {
      // Not available; fall through to "unknown".
    }
    return null;
  }

  const os = detectOS();

  function promoteWindows() {
    document.querySelectorAll('[data-cta]').forEach((row) => {
      const mac = row.querySelector('[data-dl="mac"]');
      const win = row.querySelector('[data-dl="win"]');
      if (!mac || !win) return;
      row.insertBefore(win, mac);
      win.classList.replace('btn-secondary', 'btn-primary');
      mac.classList.replace('btn-primary', 'btn-secondary');
    });
  }

  function applyMacArch(arch) {
    const other = arch === 'x64' ? 'arm64' : 'x64';
    document.querySelectorAll('[data-dl="mac"]').forEach((a) => {
      a.href = MAC_URL[arch];
    });
    const note = document.querySelector('[data-mac-note]');
    const alt = document.querySelector('[data-mac-alt]');
    if (note && alt) {
      note.textContent = arch === 'x64' ? 'For Macs with Intel.' : 'For Macs with Apple silicon.';
      alt.textContent = arch === 'x64' ? 'Apple silicon version' : 'Intel Mac version';
      alt.href = MAC_URL[other];
    }
  }

  if (os === 'win') {
    promoteWindows();
    const note = document.querySelector('[data-mac-note]');
    if (note) note.textContent = 'Also for Macs with Apple silicon.';
  }

  if (os === 'mac') {
    detectMacArch().then((arch) => {
      if (!arch) return;
      applyMacArch(arch);
      const card = document.querySelector(`.dl-card[data-arch="${arch}"]`);
      if (card) card.classList.add('is-recommended');
    });
  }

  // ---------- Install tabs ----------
  const tablist = document.querySelector('[role="tablist"]');
  if (tablist) {
    const tabs = [...tablist.querySelectorAll('[role="tab"]')];

    function select(tab, focus) {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      });
      tablist.dataset.active = tab.dataset.tab;
      if (focus) tab.focus();
    }

    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab, false));
      tab.addEventListener('keydown', (event) => {
        let next = null;
        if (event.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
        if (event.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
        if (event.key === 'Home') next = tabs[0];
        if (event.key === 'End') next = tabs[tabs.length - 1];
        if (next) {
          event.preventDefault();
          select(next, true);
        }
      });
    });

    select(tabs.find((t) => t.dataset.tab === os) || tabs[0], false);
  }

  // ---------- Copy buttons ----------
  document.querySelectorAll('[data-copy]').forEach((button) => {
    const label = button.textContent;
    let timer = 0;
    button.addEventListener('click', async () => {
      const text = document.querySelector(button.dataset.copy).textContent.trim();
      let ok = true;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Clipboard API needs a secure context; fall back to selecting the text for the user.
        const range = document.createRange();
        range.selectNodeContents(document.querySelector(button.dataset.copy));
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        ok = document.execCommand('copy');
      }
      // If both paths failed the text is still selected, so point the user at the shortcut instead.
      button.textContent = ok ? 'Copied' : os === 'win' ? 'Press Ctrl+C' : 'Press ⌘C';
      button.classList.toggle('done', ok);
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.textContent = label;
        button.classList.remove('done');
      }, 1800);
    });
  });

  // ---------- Appearance: Auto / Light / Dark ----------
  // The choice lives on <html data-theme>; the inline script in <head> restores it before first paint.
  // ?theme=light|dark previews a theme without saving it.
  const themeSwitch = document.getElementById('themeSwitch');
  const THEME_COLORS = { light: '#fbfbfd', dark: '#000000' };
  const themeMetas = [...document.querySelectorAll('meta[name="theme-color"]')];
  const metaDefaults = themeMetas.map((meta) => meta.content);

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    // Browser chrome (mobile address bar) follows the forced theme instead of the system one.
    themeMetas.forEach((meta, i) => {
      meta.content = THEME_COLORS[theme] || metaDefaults[i];
    });
    themeSwitch.querySelectorAll('button').forEach((button) => {
      const on = button.dataset.theme === (theme || 'auto');
      button.setAttribute('aria-checked', String(on));
      button.tabIndex = on ? 0 : -1;
    });
  }

  function saveTheme(theme) {
    try {
      if (theme === 'auto') localStorage.removeItem('hop-theme');
      else localStorage.setItem('hop-theme', theme);
    } catch {
      // Private mode or blocked storage: the switch still works for this visit.
    }
  }

  if (themeSwitch) {
    const previewed = new URLSearchParams(location.search).get('theme');
    applyTheme(previewed || document.documentElement.dataset.theme || 'auto');

    themeSwitch.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-theme]');
      if (!button) return;
      applyTheme(button.dataset.theme);
      saveTheme(button.dataset.theme);
    });

    // Arrow keys move between the options, like a native segmented control.
    themeSwitch.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const buttons = [...themeSwitch.querySelectorAll('button')];
      const current = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
      const next = buttons[(current + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
      next.focus();
      next.click();
    });
  }

  // ---------- Analytics for the private dashboard ----------
  // Cookieless: the server only keeps daily counts. Only the Vercel deploy has the API,
  // so the GitHub Pages mirror and local files skip it.
  const tracking = location.protocol === 'https:' && !location.hostname.endsWith('github.io');
  function track(event) {
    if (!tracking) return;
    const body = JSON.stringify(event);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('/api/track', body)) return;
    } catch {
      // fall through to fetch
    }
    fetch('/api/track', { method: 'POST', body, keepalive: true }).catch(() => {});
  }

  track({
    t: 'pv',
    p: location.pathname,
    r: document.referrer,
    u: new URLSearchParams(location.search).get('utm_source') || undefined,
  });

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (link) {
      const download = link.href.match(/\/releases\/latest\/download\/Hop-(mac-arm64|mac-x64|windows-x64)\./);
      if (download) {
        const place = link.closest('#install') ? 'install' : link.closest('#top') ? 'hero' : link.closest('[data-cta]') ? 'footer' : 'other';
        track({ t: 'dl', k: download[1], w: place });
      } else if (/github\.com\/0xCodez\/hop\/releases\/?$/.test(link.href)) {
        track({ t: 'click', k: 'all-releases' });
      } else if (/github\.com\/0xCodez\/hop\/?$/.test(link.href)) {
        track({ t: 'click', k: 'github' });
      }
      return;
    }
    const button = event.target.closest('button');
    if (!button) return;
    if (button.matches('[data-copy]')) track({ t: 'click', k: 'copy-xattr' });
    else if (button.id === 'tab-mac' || button.id === 'tab-win') track({ t: 'click', k: button.id });
    else if (button.matches('#themeSwitch button')) track({ t: 'click', k: `theme-${button.dataset.theme}` });
  });

  // Which questions people open is a hint at what the install steps don't answer.
  document.querySelectorAll('#faq details').forEach((details, i) => {
    details.addEventListener('toggle', () => {
      if (details.open) track({ t: 'click', k: `faq-${i + 1}` });
    });
  });

  // ---------- Nav hairline once the page scrolls ----------
  const nav = document.getElementById('nav');
  const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---------- Scroll reveal ----------
  const reveals = [...document.querySelectorAll('.reveal')];
  // Cards in the same row arrive one after another rather than all at once.
  document.querySelectorAll('.bento .card, .steps .step').forEach((el, i) => {
    el.style.setProperty('--d', `${(i % 3) * 0.08}s`);
  });
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('in'));
  }
})();
