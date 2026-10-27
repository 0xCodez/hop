// Light effects for the "hop": the burst that blooms from an avatar when a transfer starts,
// the shimmering bridge while files are dragged over a device, and the glowing trail behind
// the flying file chip. Bursts are drawn by a WebGL shader when it is available (real glow
// and colour dispersion) and by Canvas 2D otherwise; bridge and trail are always Canvas 2D.
// The render loop only runs while something is on screen, so an idle window costs nothing.
window.hopFx = (() => {
  const BURST_MS = 1300;
  const MAX_BURSTS = 4;
  const forced2d = new URLSearchParams(location.search).get('fx') === '2d';
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');

  const glCanvas = document.getElementById('fxGl');
  const canvas = document.getElementById('fx2d');
  const ctx = canvas.getContext('2d');

  // cyan -> blue -> violet -> pink; deeper on light backgrounds so the colour still reads there.
  const palettes = {
    dark: { stops: [[110, 228, 255], [70, 140, 255], [158, 104, 255], [255, 104, 200]], hot: [255, 250, 244] },
    light: { stops: [[0, 172, 238], [0, 104, 255], [116, 64, 238], [232, 48, 150]], hot: [70, 140, 255] },
  };

  const bursts = [];
  const trails = [];
  const bridge = { get: null, last: null, amt: 0 };
  let raf = 0;
  let lastFrame = 0;
  let width = 0;
  let height = 0;
  let scale = 1;

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const smooth = (a, b, v) => {
    const t = clamp01((v - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  const easeOut = (t) => 1 - (1 - t) ** 3;
  const isDark = () => darkQuery.matches;
  const palette = () => (isDark() ? palettes.dark : palettes.light);

  function iri(x, pal = palette()) {
    const s = pal.stops;
    const v = clamp01(x) * (s.length - 1);
    const i = Math.min(s.length - 2, Math.floor(v));
    const f = v - i;
    return s[i].map((c, k) => Math.round(c + (s[i + 1][k] - c) * f));
  }

  const rgba = (rgb, a) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Math.max(0, a).toFixed(3)})`;

  // ---------- WebGL burst renderer ----------

  const VERTEX = `
    attribute vec2 a_pos;
    void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

  const FRAGMENT = `
    // Pixel distances reach ~2000 at 2x; mediump can map to half precision.
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    uniform vec2 u_res;
    uniform float u_scale;
    uniform float u_dark;
    uniform vec4 u_burst[${MAX_BURSTS}];
    uniform float u_reach[${MAX_BURSTS}];

    vec3 iri(float x) {
      vec3 c0 = mix(vec3(0.00, 0.67, 0.93), vec3(0.43, 0.89, 1.00), u_dark);
      vec3 c1 = mix(vec3(0.00, 0.41, 1.00), vec3(0.27, 0.55, 1.00), u_dark);
      vec3 c2 = mix(vec3(0.45, 0.25, 0.93), vec3(0.62, 0.41, 1.00), u_dark);
      vec3 c3 = mix(vec3(0.91, 0.19, 0.59), vec3(1.00, 0.41, 0.78), u_dark);
      x = clamp(x, 0.0, 1.0) * 3.0;
      if (x < 1.0) return mix(c0, c1, x);
      if (x < 2.0) return mix(c1, c2, x - 1.0);
      return mix(c2, c3, x - 2.0);
    }

    void main() {
      vec2 p = vec2(gl_FragCoord.x, u_res.y * u_scale - gl_FragCoord.y) / u_scale;
      vec3 glow = vec3(0.0);
      vec3 hot = mix(vec3(0.16, 0.66, 1.00), vec3(1.00, 0.98, 0.96), u_dark);
      for (int i = 0; i < ${MAX_BURSTS}; i++) {
        vec4 b = u_burst[i];
        if (b.z < 0.0) continue;
        float t = b.z;
        vec2 d = p - b.xy;
        float dist = length(d);
        float ang = atan(d.y, d.x);
        float k = 1.0 - t;
        float e = 1.0 - k * k * k;
        float calm = 1.0 - t;
        // The front wobbles like a liquid while it is young, then evens out.
        float wob = (sin(ang * 4.0 + t * 9.0) * 0.6 + sin(ang * 7.0 - t * 6.0 + 1.7) * 0.4) * 2.5 * calm;
        float r = u_reach[i] * e + wob;
        float w = mix(8.0, 46.0, e);
        float s = (dist - r) / w;
        // White-hot front; each channel peaks at a slightly different radius (dispersion).
        // Squared by hand: pow() is undefined for a negative base (NaN on Metal's fast pow).
        float s0 = (s + 0.16) * 4.5;
        float s1 = s * 4.5;
        float s2 = (s - 0.16) * 4.5;
        vec3 front = exp(-vec3(s0 * s0, s1 * s1, s2 * s2));
        front = mix(vec3(dot(front, vec3(0.333))) * hot, front * hot, u_dark);
        // The iridescent fringe trails behind the front and shimmers around the ring.
        float behind = max(-s, 0.0);
        // smoothstep needs edge0 < edge1, so falling edges are written as 1 - rising.
        float band = (1.0 - smoothstep(-0.1, 0.2, s)) * exp(-behind * 0.75);
        float hue = behind * mix(0.5, 0.34, u_dark) + 0.07 * sin(ang * 2.0 + t * 6.0) + 0.04 * sin(ang * 7.0 - t * 4.0);
        vec3 fringe = iri(hue) * band;
        // A faint sheen lingers over everything the wave has crossed.
        float wash = (1.0 - smoothstep(-3.0, 0.0, s)) * 0.08 * calm;
        // The bright bloom where the two devices "touch".
        float flash = smoothstep(0.0, 0.07, t) * (1.0 - smoothstep(0.08, 0.5, t));
        float cr = 18.0 + 70.0 * e;
        float core = exp(-dist * dist / (cr * cr)) * flash;
        float fade = 1.0 - smoothstep(0.55, 1.0, t);
        glow += (front * mix(0.6, 1.1, u_dark) + fringe * 0.9 + iri(0.3) * wash + hot * core * mix(0.8, 1.2, u_dark)) * fade * b.w;
      }
      float m = max(glow.r, max(glow.g, glow.b));
      if (u_dark > 0.5) {
        float a = clamp(m, 0.0, 1.0);
        gl_FragColor = vec4(min(glow, vec3(a)), a);
      } else {
        // On a light window, light can't be added: paint saturated colour instead.
        vec3 hue = glow / max(m, 0.0001);
        float a = clamp(m * 0.75, 0.0, 0.7);
        gl_FragColor = vec4(hue * a, a);
      }
    }`;

  let gl = null;
  let glState = null;

  function initGl() {
    if (forced2d || !glCanvas) return null;
    const context = glCanvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' });
    if (!context) return null;
    const compile = (type, source) => {
      const shader = context.createShader(type);
      context.shaderSource(shader, source);
      context.compileShader(shader);
      return context.getShaderParameter(shader, context.COMPILE_STATUS) ? shader : null;
    };
    const vs = compile(context.VERTEX_SHADER, VERTEX);
    const fs = compile(context.FRAGMENT_SHADER, FRAGMENT);
    if (!vs || !fs) return null;
    const program = context.createProgram();
    context.attachShader(program, vs);
    context.attachShader(program, fs);
    context.linkProgram(program);
    if (!context.getProgramParameter(program, context.LINK_STATUS)) return null;
    context.useProgram(program);
    // One triangle that covers the whole viewport.
    const buffer = context.createBuffer();
    context.bindBuffer(context.ARRAY_BUFFER, buffer);
    context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), context.STATIC_DRAW);
    const pos = context.getAttribLocation(program, 'a_pos');
    context.enableVertexAttribArray(pos);
    context.vertexAttribPointer(pos, 2, context.FLOAT, false, 0, 0);
    glState = {
      res: context.getUniformLocation(program, 'u_res'),
      scale: context.getUniformLocation(program, 'u_scale'),
      dark: context.getUniformLocation(program, 'u_dark'),
      burst: context.getUniformLocation(program, 'u_burst'),
      reach: context.getUniformLocation(program, 'u_reach'),
      burstData: new Float32Array(MAX_BURSTS * 4),
      reachData: new Float32Array(MAX_BURSTS),
    };
    return context;
  }

  gl = initGl();
  if (glCanvas) {
    glCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      gl = null;
    });
    glCanvas.addEventListener('webglcontextrestored', () => {
      gl = initGl();
      wake();
    });
  }

  function drawBurstsGl(active, now) {
    const { burstData, reachData } = glState;
    burstData.fill(0);
    reachData.fill(0);
    for (let i = 0; i < MAX_BURSTS; i++) {
      const b = active[i];
      if (b) {
        burstData.set([b.x, b.y, clamp01((now - b.start) / BURST_MS), b.strength], i * 4);
        reachData[i] = b.reach;
      } else {
        burstData[i * 4 + 2] = -1;
      }
    }
    gl.viewport(0, 0, glCanvas.width, glCanvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(glState.res, width, height);
    gl.uniform1f(glState.scale, glCanvas.width / width);
    gl.uniform1f(glState.dark, isDark() ? 1 : 0);
    gl.uniform4fv(glState.burst, burstData);
    gl.uniform1fv(glState.reach, reachData);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function clearGl() {
    if (!gl) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // ---------- Canvas 2D: burst fallback, bridge, trail ----------

  function drawBurst2d(b, p) {
    const pal = palette();
    const fade = 1 - smooth(0.55, 1, p);
    const e = easeOut(p);
    const r = b.reach * e;
    const w = 10 + 54 * e;
    const inner = Math.max(0, r - w * 3);
    const outer = r + w * 0.5;
    const at = (radius) => clamp01((radius - inner) / (outer - inner || 1));
    const [cyan, blue, violet, pink] = pal.stops;
    const ring = ctx.createRadialGradient(b.x, b.y, inner, b.x, b.y, outer);
    ring.addColorStop(0, rgba(pink, 0));
    ring.addColorStop(at(r - w * 2.2), rgba(pink, 0.16));
    ring.addColorStop(at(r - w * 1.5), rgba(violet, 0.4));
    ring.addColorStop(at(r - w * 0.9), rgba(blue, 0.58));
    ring.addColorStop(at(r - w * 0.4), rgba(cyan, 0.78));
    ring.addColorStop(at(r - w * 0.06), rgba(pal.hot, isDark() ? 0.95 : 0.7));
    ring.addColorStop(1, rgba(pal.hot, 0));
    ctx.globalAlpha = fade * b.strength;
    ctx.fillStyle = ring;
    ctx.beginPath();
    ctx.arc(b.x, b.y, outer, 0, Math.PI * 2);
    ctx.fill();

    const flash = smooth(0, 0.07, p) * (1 - smooth(0.08, 0.5, p));
    if (flash > 0.01) {
      const cr = (18 + 70 * e) * 2;
      const core = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, cr);
      core.addColorStop(0, rgba(pal.hot, 0.95));
      core.addColorStop(0.35, rgba(isDark() ? pal.hot : blue, 0.45));
      core.addColorStop(1, rgba(cyan, 0));
      ctx.globalAlpha = flash * b.strength;
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(b.x, b.y, cr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Reduced motion: no sweeping wave, just a soft glow that fades in and out.
  function drawGentle(b, p) {
    const pal = palette();
    const glow = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, 150);
    glow.addColorStop(0, rgba(pal.stops[1], 0.5));
    glow.addColorStop(1, rgba(pal.stops[2], 0));
    ctx.globalAlpha = Math.sin(Math.PI * p) * b.strength;
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 150, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // How far a ray from the centre of `p` in direction (dx, dy) travels before leaving `box`.
  function exitDistance(p, dx, dy, box) {
    const tx = dx > 0 ? (box.right - p.x) / dx : dx < 0 ? (box.left - p.x) / dx : Infinity;
    const ty = dy > 0 ? (box.bottom - p.y) / dy : dy < 0 ? (box.top - p.y) / dy : Infinity;
    return Math.min(tx, ty);
  }

  function drawBridge(now, dt) {
    const target = bridge.get ? 1 : 0;
    bridge.amt += (target - bridge.amt) * (1 - Math.exp(-dt / 90));
    if (bridge.get) bridge.last = bridge.get() || bridge.last;
    if (!bridge.last || bridge.amt < 0.01) {
      if (!bridge.get) bridge.last = null;
      return Boolean(bridge.get);
    }
    const { a, b } = bridge.last;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < a.r + b.r + 24) return true;
    const ux = dx / len;
    const uy = dy / len;
    const sx = a.x + ux * (a.r + 6);
    const sy = a.y + uy * (a.r + 6);
    // Stop at the edge of the device's block (avatar and name), so the beam never crosses its label.
    const stop = b.box ? Math.max(b.r, exitDistance(b, -ux, -uy, b.box)) : b.r;
    const ex = b.x - ux * (stop + 8);
    const ey = b.y - uy * (stop + 8);
    // A gentle bow, always curving upwards, reads as a beam of light rather than a line.
    let nx = -uy;
    let ny = ux;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    const bow = len * 0.07;
    const cx = (sx + ex) / 2 + nx * bow;
    const cy = (sy + ey) / 2 + ny * bow;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(cx, cy, ex, ey);
    };
    const pal = palette();
    const dark = isDark();
    const reduced = reducedQuery.matches;
    const shimmer = reduced ? 0 : now / 600;
    const grad = ctx.createLinearGradient(sx, sy, ex, ey);
    for (let i = 0; i <= 5; i++) {
      const u = i / 5;
      grad.addColorStop(u, rgba(iri(u * 0.85 + 0.15 * Math.sin(shimmer + u * 5), pal), 1));
    }
    const pulse = reduced ? 1 : 0.85 + 0.15 * Math.sin(now / 260);
    const amt = bridge.amt;
    ctx.lineCap = 'round';
    ctx.strokeStyle = grad;

    ctx.globalAlpha = (dark ? 0.32 : 0.22) * amt;
    ctx.lineWidth = 16 * pulse;
    ctx.shadowColor = rgba(pal.stops[2], 0.9);
    ctx.shadowBlur = 20;
    path();
    ctx.stroke();

    ctx.globalAlpha = 0.85 * amt;
    ctx.lineWidth = 3;
    ctx.shadowColor = rgba(pal.stops[0], 0.9);
    ctx.shadowBlur = 10;
    path();
    ctx.stroke();

    ctx.shadowBlur = 0;
    if (dark) {
      ctx.globalAlpha = 0.9 * amt;
      ctx.strokeStyle = rgba(pal.hot, 1);
      ctx.lineWidth = 1.2;
      path();
      ctx.stroke();
    }

    // Beads of light flowing towards the device.
    if (!reduced) {
      ctx.globalAlpha = amt;
      ctx.strokeStyle = dark ? rgba(pal.hot, 0.95) : '#fff';
      ctx.lineWidth = 4;
      ctx.setLineDash([0.1, 22]);
      ctx.lineDashOffset = -((now * 0.07) % 22.1);
      path();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
    return true;
  }

  function drawTrail(tr, now) {
    const t = (now - tr.start) / tr.duration;
    const head = Math.min(1, t);
    const tail = Math.max(0, t - 0.4);
    if (tail >= 1) return false;
    const pal = palette();
    const dark = isDark();
    const steps = 28;
    ctx.lineCap = 'round';
    ctx.shadowColor = rgba(pal.stops[2], 0.8);
    ctx.shadowBlur = dark ? 12 : 6;
    let prev = tr.at(tail);
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const pt = tr.at(tail + (head - tail) * k);
      ctx.strokeStyle = rgba(iri(1 - k, pal), k ** 1.4 * (dark ? 0.9 : 0.8));
      ctx.lineWidth = 1 + 9 * k;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      prev = pt;
    }
    ctx.shadowBlur = 0;
    return true;
  }

  // ---------- loop ----------

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    if (w === width && h === height && dpr === scale) return;
    width = w;
    height = h;
    scale = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (glCanvas) {
      // The glow is soft, so the shader can render below native resolution.
      const glScale = Math.min(dpr, 1.5);
      glCanvas.width = Math.round(w * glScale);
      glCanvas.height = Math.round(h * glScale);
    }
  }

  function frame(now) {
    raf = 0;
    const dt = lastFrame ? Math.min(64, now - lastFrame) : 16;
    lastFrame = now;
    resize();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = isDark() ? 'lighter' : 'source-over';

    for (let i = bursts.length - 1; i >= 0; i--) {
      if (now - bursts[i].start >= BURST_MS) bursts.splice(i, 1);
    }
    const shader = bursts.filter((b) => !b.gentle);
    if (gl && shader.length) drawBurstsGl(shader, now);
    else clearGl();
    for (const b of bursts) {
      const p = clamp01((now - b.start) / BURST_MS);
      if (b.gentle) drawGentle(b, p);
      else if (!gl) drawBurst2d(b, p);
    }

    let busy = bursts.length > 0;
    if (drawBridge(now, dt)) busy = true;
    for (let i = trails.length - 1; i >= 0; i--) {
      if (drawTrail(trails[i], now)) busy = true;
      else trails.splice(i, 1);
    }
    ctx.globalCompositeOperation = 'source-over';

    if (busy) raf = requestAnimationFrame(frame);
    else {
      lastFrame = 0;
      ctx.clearRect(0, 0, width, height);
      clearGl();
    }
  }

  function wake() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function reachFrom(x, y) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    return Math.max(Math.hypot(x, y), Math.hypot(w - x, y), Math.hypot(x, h - y), Math.hypot(w - x, h - y)) + 60;
  }

  return {
    duration: BURST_MS,
    get mode() {
      return gl ? 'webgl' : '2d';
    },
    reduced: () => reducedQuery.matches,
    // When the front of a burst started at (x, y) reaches a point `dist` away, in ms.
    arrival(x, y, dist) {
      const p = clamp01(dist / reachFrom(x, y));
      return (1 - Math.cbrt(1 - p)) * BURST_MS;
    },
    burst(x, y, { strength = 1 } = {}) {
      if (bursts.length >= MAX_BURSTS) bursts.shift();
      bursts.push({ x, y, strength, start: performance.now(), reach: reachFrom(x, y), gentle: reducedQuery.matches });
      wake();
    },
    // `get` returns { a: {x, y, r}, b: {x, y, r, box?} } each frame, or pass null to fade it out.
    // `box` is a DOMRect-like area around b that the beam should stop short of.
    bridge(get) {
      bridge.get = get;
      wake();
    },
    // `at(t)` gives the chip's centre for t in 0..1 over `duration` ms.
    trail(at, duration) {
      if (reducedQuery.matches) return;
      trails.push({ at, duration, start: performance.now() });
      wake();
    },
  };
})();
