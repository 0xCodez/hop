(() => {
  const KEY_STORE = 'hop-dash-key';
  const RANGE_STORE = 'hop-dash-days';
  const REFRESH_MS = 60 * 1000;
  const PLATFORMS = [
    { key: 'mac-arm64', label: 'Mac · Apple silicon', color: 'var(--s1)' },
    { key: 'mac-x64', label: 'Mac · Intel', color: 'var(--s2)' },
    { key: 'windows-x64', label: 'Windows', color: 'var(--s3)' },
  ];
  const NAMES = {
    systems: { mac: 'macOS', windows: 'Windows', ios: 'iPhone / iPad', android: 'Android', linux: 'Linux', other: 'Other' },
    devices: { desktop: 'Desktop', mobile: 'Phone', tablet: 'Tablet' },
    places: { hero: 'Top of the page', install: 'Install section', footer: 'Bottom of the page', other: 'Elsewhere' },
    clicks: {
      'copy-xattr': 'Copied the xattr command',
      'tab-mac': 'Opened macOS install steps',
      'tab-win': 'Opened Windows install steps',
      github: 'Opened GitHub',
      'all-releases': 'Opened all releases',
      'theme-light': 'Switched to light',
      'theme-dark': 'Switched to dark',
      'theme-auto': 'Switched to automatic',
      'x-card': 'Opened X from the “Made by” card',
      'x-nav': 'Opened X from the menu',
      'x-footer': 'Opened X from the footer',
    },
    sources: { direct: 'Direct / unknown', x: 'X', 'hacker news': 'Hacker News' },
  };
  const FAQ = ["Devices don't see each other", 'Where files are saved', 'Is it secure', 'Security warning', 'Is it free'];

  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        if (v == null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch {
        // Private mode: the session still works, it just won't be remembered.
      }
    },
  };

  const demo = new URLSearchParams(location.search).has('demo');
  let key = store.get(KEY_STORE);
  let days = Number(store.get(RANGE_STORE)) || 30;
  let timer = 0;
  let last = null;

  // ---------- formatting ----------

  const fmt = new Intl.NumberFormat('en-US');
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  const big = (n) => (n >= 10000 ? compact.format(n) : fmt.format(n));
  const regions = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
  const dayLabel = (d, opts = { month: 'short', day: 'numeric' }) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });

  function country(code) {
    if (!code || code === 'XX') return 'Unknown';
    const flag = String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0)));
    let name = code;
    try {
      name = regions?.of(code) || code;
    } catch {
      // unknown code: keep it as is
    }
    return `${flag}  ${name}`;
  }

  function label(group, raw) {
    if (group === 'countries') return country(raw);
    if (group === 'clicks' && /^faq-\d+$/.test(raw)) return `FAQ: ${FAQ[Number(raw.slice(4)) - 1] || raw}`;
    return NAMES[group]?.[raw] || raw;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  // ---------- data ----------

  async function load() {
    if (demo) return demoData(days);
    const res = await fetch(`api/dashboard?days=${days}`, { headers: { 'x-dash-key': key || '' }, cache: 'no-store' }).catch(() => null);
    if (!res) throw Object.assign(new Error('offline'), { code: 'offline' });
    if (res.status === 401) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || 'error'), { code: body.error || 'error' });
    return body;
  }

  async function refresh(manual) {
    const button = $('refresh');
    if (manual) button.classList.add('spinning');
    try {
      last = await load();
      // Show first: the charts are drawn at their container's size, which is 0 while hidden.
      showApp();
      render(last);
    } catch (err) {
      if (err.code === 'unauthorized') return signOut('Wrong password.');
      if (err.code === 'no-password') return signOut('Set DASHBOARD_PASSWORD in Vercel → hop → Settings → Environment Variables, then redeploy.');
      if (!last) return signOut('Couldn’t reach the dashboard API. Try again in a moment.');
      $('footer').textContent = 'Couldn’t refresh — showing the last numbers.';
    } finally {
      button.classList.remove('spinning');
    }
    clearTimeout(timer);
    timer = setTimeout(() => refresh(false), REFRESH_MS);
  }

  // ---------- sign in / out ----------

  function showApp() {
    $('login').hidden = true;
    $('app').hidden = false;
  }

  function signOut(message) {
    clearTimeout(timer);
    key = null;
    last = null;
    store.set(KEY_STORE, null);
    $('app').hidden = true;
    $('login').hidden = false;
    $('loginError').textContent = message || '';
    $('password').value = '';
    $('password').focus();
  }

  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    key = $('password').value;
    $('loginError').textContent = '';
    store.set(KEY_STORE, key);
    await refresh(true);
  });

  $('signOut').addEventListener('click', () => signOut(''));
  $('refresh').addEventListener('click', () => refresh(true));

  function renderRange() {
    $('range').querySelectorAll('button').forEach((b) => {
      const on = Number(b.dataset.days) === days;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }

  $('range').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-days]');
    if (!button) return;
    days = Number(button.dataset.days);
    store.set(RANGE_STORE, String(days));
    renderRange();
    refresh(true);
  });

  // ---------- rendering ----------

  function render(data) {
    $('storageNotice').hidden = data.storage !== 'memory' || demo;

    const sumPv = data.pageviews;
    const conversion = data.visitors ? Math.min(100, (data.downloaders / data.visitors) * 100) : 0;
    $('kVisitors').textContent = big(data.visitors);
    $('kVisitorsSub').textContent = `unique, last ${data.days} days`;
    $('kDownloads').textContent = big(data.downloads);
    $('kDownloadsSub').textContent = `${big(data.downloaders)} unique people`;
    $('kConversion').textContent = `${conversion.toFixed(conversion >= 10 || conversion === 0 ? 0 : 1)}%`;
    $('kPageviews').textContent = big(sumPv);
    $('kPageviewsSub').textContent = data.visitors ? `${(sumPv / data.visitors).toFixed(1)} per visitor` : 'no visits yet';
    $('kOnline').textContent = fmt.format(data.online);

    if (data.releases) {
      const total = data.releases.reduce((s, r) => s + Object.values(r.assets).reduce((a, b) => a + b, 0), 0);
      $('kGithub').textContent = big(total);
      $('kGithubSub').textContent = `${data.releases.length} releases, all time`;
    } else {
      $('kGithub').textContent = '—';
      $('kGithubSub').textContent = 'GitHub didn’t answer';
    }

    drawVisitors(data.series);
    drawDownloads(data.series);
    bars('systems', data.systems);
    bars('sources', data.sources);
    bars('countries', data.countries);
    bars('places', data.places);
    bars('devices', data.devices);
    bars('clicks', data.clicks);
    releasesTable(data.releases);

    const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    $('footer').textContent = `Updated ${time} · refreshes every minute · cookieless, no IPs stored`;
  }

  function bars(id, rows) {
    const list = $(id);
    const total = rows.reduce((s, [, v]) => s + v, 0);
    if (!total) {
      list.innerHTML = '<li class="none">Nothing yet</li>';
      return;
    }
    const max = rows[0][1];
    list.innerHTML = rows
      .slice(0, 8)
      .map(
        ([raw, v]) => `<li title="${esc(label(id, raw))}: ${fmt.format(v)}">
          <span class="fill" style="width:${Math.max(2, (v / max) * 100)}%"></span>
          <span class="label">${esc(label(id, raw))}</span>
          <span class="num">${big(v)}</span>
          <span class="pct">${Math.round((v / total) * 100)}%</span>
        </li>`,
      )
      .join('');
  }

  function releasesTable(releases) {
    const table = $('releasesTable');
    if (!releases?.length) {
      table.innerHTML = `<tbody><tr><td class="muted">${releases ? 'No releases yet.' : 'Couldn’t load releases from GitHub.'}</td></tr></tbody>`;
      return;
    }
    const head = `<thead><tr><th>Release</th><th>Published</th>${PLATFORMS.map((p) => `<th>${p.label}</th>`).join('')}<th>Total</th></tr></thead>`;
    const body = releases
      .map((r) => {
        const counts = PLATFORMS.map((p) => r.assets[p.key] || 0);
        const date = r.date ? new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
        return `<tr><td>${esc(r.tag)}</td><td>${date}</td>${counts.map((c) => `<td>${fmt.format(c)}</td>`).join('')}<td><b>${fmt.format(counts.reduce((a, b) => a + b, 0))}</b></td></tr>`;
      })
      .join('');
    table.innerHTML = head + `<tbody>${body}</tbody>`;
  }

  // ---------- SVG charts ----------

  const NS = 'http://www.w3.org/2000/svg';
  const PAD = { top: 12, right: 8, bottom: 26, left: 40 };

  function svgEl(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.append(node);
    return node;
  }

  // Clean round ticks: 0, 5, 10… or 0, 200, 400…
  function niceMax(v) {
    if (v <= 4) return 4;
    const step = 10 ** Math.floor(Math.log10(v / 4));
    const nice = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => s * 4 >= v);
    return nice * 4;
  }

  function frame(container, max) {
    container.innerHTML = '';
    const w = container.clientWidth;
    const h = container.clientHeight;
    const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, role: 'img' }, container);
    const plot = { x: PAD.left, y: PAD.top, w: w - PAD.left - PAD.right, h: h - PAD.top - PAD.bottom };
    const yMax = niceMax(max);
    for (let i = 0; i <= 4; i++) {
      const y = plot.y + plot.h - (plot.h * i) / 4;
      svgEl('line', { class: i === 0 ? 'baseline' : 'gridline', x1: plot.x, x2: plot.x + plot.w, y1: y, y2: y }, svg);
      const t = svgEl('text', { class: 'tick', x: plot.x - 8, y: y + 4, 'text-anchor': 'end' }, svg);
      t.textContent = compact.format((yMax * i) / 4);
    }
    return { svg, plot, yMax, y: (v) => plot.y + plot.h - (v / yMax) * plot.h };
  }

  function xLabels(svg, plot, series, xOf) {
    const picks = series.length <= 7 ? series.map((_, i) => i) : [0, Math.floor((series.length - 1) / 2), series.length - 1];
    for (const i of picks) {
      const anchor = i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle';
      const t = svgEl('text', { class: 'tick', x: xOf(i), y: plot.y + plot.h + 18, 'text-anchor': anchor }, svg);
      t.textContent = dayLabel(series[i].d);
    }
  }

  function tooltip(html, clientX, clientY) {
    const tip = $('tooltip');
    if (!html) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const { width, height } = tip.getBoundingClientRect();
    const x = clientX + 16 + width > window.innerWidth ? clientX - width - 16 : clientX + 16;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, clientY - height - 12)}px`;
  }

  function drawVisitors(series) {
    const container = $('visitorsChart');
    const max = Math.max(...series.map((r) => r.uv));
    const { svg, plot, y } = frame(container, max);
    const step = series.length > 1 ? plot.w / (series.length - 1) : 0;
    const xOf = (i) => (series.length > 1 ? plot.x + i * step : plot.x + plot.w / 2);
    const pts = series.map((r, i) => [xOf(i), y(r.uv)]);
    const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join('');
    svgEl('path', { class: 'area', d: `${line}L${pts.at(-1)[0]} ${y(0)}L${pts[0][0]} ${y(0)}Z` }, svg);
    svgEl('path', { class: 'line', d: line }, svg);
    if (!max) {
      const t = svgEl('text', { class: 'empty', x: plot.x + plot.w / 2, y: plot.y + plot.h / 2, 'text-anchor': 'middle' }, svg);
      t.textContent = 'No visitors yet in this range';
    }
    // End-of-line marker + value: the one direct label this chart gets.
    const [ex, ey] = pts.at(-1);
    svgEl('circle', { class: 'dot', cx: ex, cy: ey, r: 4 }, svg);
    xLabels(svg, plot, series, xOf);

    const cross = svgEl('line', { class: 'crosshair', y1: plot.y, y2: plot.y + plot.h, visibility: 'hidden' }, svg);
    const dot = svgEl('circle', { class: 'dot', r: 5, visibility: 'hidden' }, svg);
    const hit = svgEl('rect', { class: 'hit', x: plot.x - step / 2, y: plot.y, width: plot.w + step, height: plot.h }, svg);
    hit.addEventListener('pointermove', (e) => {
      const box = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(series.length - 1, Math.round((e.clientX - box.left - plot.x) / (step || 1))));
      const [px, py] = pts[i];
      cross.setAttribute('x1', px);
      cross.setAttribute('x2', px);
      cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', px);
      dot.setAttribute('cy', py);
      dot.setAttribute('visibility', 'visible');
      const r = series[i];
      tooltip(
        `<div class="tt-title">${dayLabel(r.d, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
         <div class="tt-row">Visitors<b>${fmt.format(r.uv)}</b></div>
         <div class="tt-row">Page views<b>${fmt.format(r.pv)}</b></div>`,
        e.clientX,
        e.clientY,
      );
    });
    hit.addEventListener('pointerleave', () => {
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      tooltip(null);
    });

    $('visitorsTable').innerHTML =
      '<thead><tr><th>Day</th><th>Visitors</th><th>Page views</th></tr></thead><tbody>' +
      [...series]
        .reverse()
        .map((r) => `<tr><td>${dayLabel(r.d, { weekday: 'short', month: 'short', day: 'numeric' })}</td><td>${fmt.format(r.uv)}</td><td>${fmt.format(r.pv)}</td></tr>`)
        .join('') +
      '</tbody>';
  }

  // Bar with a 4px rounded data-end and a square base.
  function topRounded(x, y, w, h, r) {
    r = Math.min(r, h, w / 2);
    return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`;
  }

  function drawDownloads(series) {
    const container = $('downloadsChart');
    $('downloadsLegend').innerHTML = PLATFORMS.map((p) => `<li><i style="background:${p.color}"></i>${p.label}</li>`).join('');
    const totals = series.map((r) => PLATFORMS.reduce((s, p) => s + (r.dl?.[p.key] || 0), 0));
    const max = Math.max(...totals);
    const { svg, plot, y } = frame(container, max);
    const band = plot.w / series.length;
    const barW = Math.max(2, Math.min(24, band * 0.62));
    const xOf = (i) => plot.x + band * i + band / 2;
    const GAP = 2;

    series.forEach((r, i) => {
      const hover = svgEl('rect', { class: 'band-hover', x: plot.x + band * i, y: plot.y, width: band, height: plot.h, rx: 6, opacity: 0 }, svg);
      let base = y(0);
      const filled = PLATFORMS.filter((p) => r.dl?.[p.key]);
      filled.forEach((p, j) => {
        const h = y(0) - y(r.dl[p.key]);
        const top = base - h;
        const isTop = j === filled.length - 1;
        // 2px surface gap between stacked segments; only the top one gets the rounded end.
        const segH = Math.max(1, h - (j > 0 ? GAP : 0));
        const segY = top;
        svgEl(
          'path',
          { d: isTop ? topRounded(xOf(i) - barW / 2, segY, barW, segH, 4) : `M${xOf(i) - barW / 2} ${segY}h${barW}v${segH}h${-barW}Z`, fill: p.color },
          svg,
        );
        base = top;
      });
      const hit = svgEl('rect', { class: 'hit', x: plot.x + band * i, y: plot.y, width: band, height: plot.h }, svg);
      hit.addEventListener('pointermove', (e) => {
        hover.setAttribute('opacity', 1);
        tooltip(
          `<div class="tt-title">${dayLabel(r.d, { weekday: 'short', month: 'short', day: 'numeric' })}</div>` +
            PLATFORMS.map((p) => `<div class="tt-row"><i style="background:${p.color}"></i>${p.label}<b>${fmt.format(r.dl?.[p.key] || 0)}</b></div>`).join('') +
            `<div class="tt-row">Total<b>${fmt.format(totals[i])}</b></div>`,
          e.clientX,
          e.clientY,
        );
      });
      hit.addEventListener('pointerleave', () => {
        hover.setAttribute('opacity', 0);
        tooltip(null);
      });
    });
    if (!max) {
      const t = svgEl('text', { class: 'empty', x: plot.x + plot.w / 2, y: plot.y + plot.h / 2, 'text-anchor': 'middle' }, svg);
      t.textContent = 'No downloads yet in this range';
    }
    xLabels(svg, plot, series, xOf);

    $('downloadsTable').innerHTML =
      `<thead><tr><th>Day</th>${PLATFORMS.map((p) => `<th>${p.label}</th>`).join('')}<th>Total</th></tr></thead><tbody>` +
      series
        .map((r, i) => ({ r, i }))
        .reverse()
        .map(
          ({ r, i }) =>
            `<tr><td>${dayLabel(r.d, { weekday: 'short', month: 'short', day: 'numeric' })}</td>${PLATFORMS.map((p) => `<td>${fmt.format(r.dl?.[p.key] || 0)}</td>`).join('')}<td>${fmt.format(totals[i])}</td></tr>`,
        )
        .join('') +
      '</tbody>';
  }

  // Charts are drawn at the container's pixel size, so redraw when it changes.
  let resizeFrame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (last && !$('app').hidden) {
        drawVisitors(last.series);
        drawDownloads(last.series);
      }
    });
  }).observe(document.body);

  // ---------- demo data (?demo) for previewing the layout without the API ----------

  function demoData(n) {
    const series = Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.now() - (n - 1 - i) * 864e5).toISOString().slice(0, 10);
      const wave = Math.round(40 + 30 * Math.sin(i / 3) + i * 4 + (i % 7 === 5 ? 60 : 0));
      const arm = Math.round(wave * 0.11);
      return { d, uv: wave, pv: Math.round(wave * 1.7), dlu: Math.round(wave * 0.18), dl: { 'mac-arm64': arm, 'mac-x64': Math.round(arm * 0.25), 'windows-x64': Math.round(arm * 0.8) } };
    });
    const sum = (f) => series.reduce((s, r) => s + f(r), 0);
    return {
      storage: 'upstash',
      days: n,
      visitors: Math.round(sum((r) => r.uv) * 0.85),
      downloaders: Math.round(sum((r) => r.dlu) * 0.9),
      pageviews: sum((r) => r.pv),
      downloads: sum((r) => r.dl['mac-arm64'] + r.dl['mac-x64'] + r.dl['windows-x64']),
      online: 7,
      series,
      systems: [['mac', 412], ['windows', 301], ['ios', 96], ['android', 41], ['linux', 12]],
      sources: [['x', 388], ['direct', 201], ['linkedin', 97], ['github', 54], ['telegram', 31], ['google', 18]],
      countries: [['US', 240], ['DE', 96], ['UA', 88], ['GB', 61], ['IN', 40], ['XX', 9]],
      places: [['hero', 151], ['install', 63], ['footer', 22]],
      devices: [['desktop', 690], ['mobile', 150], ['tablet', 22]],
      clicks: [['copy-xattr', 58], ['tab-win', 44], ['github', 31], ['faq-1', 17], ['theme-dark', 9]],
      releases: [
        { tag: 'v0.2.1', date: new Date().toISOString(), assets: { 'mac-arm64': 142, 'mac-x64': 31, 'windows-x64': 118 } },
        { tag: 'v0.2.0', date: new Date(Date.now() - 864e5).toISOString(), assets: { 'mac-arm64': 64, 'mac-x64': 12, 'windows-x64': 49 } },
      ],
    };
  }

  // ---------- start ----------

  renderRange();
  if (key || demo) refresh(false);
  else signOut('');
})();
