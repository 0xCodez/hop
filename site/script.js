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
