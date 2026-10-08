/* Shared client helpers: DOM builder, shapes, storage, toasts, sound synth, confetti, countdown. */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /** h('div', {class:'x', onclick: fn}, 'text', child) — strings become text nodes (XSS-safe). */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'html') el.innerHTML = v; // only for trusted constants (svg icons)
        else if (k === 'value') el.value = v; // property, so <textarea> gets its content too
        else if (k in el && typeof v !== 'string') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const SHAPE_SVG = [
    '<svg viewBox="0 0 32 32"><path d="M16 3.5 30 28H2z" fill="#fff"/></svg>',
    '<svg viewBox="0 0 32 32"><path d="M16 2 30 16 16 30 2 16z" fill="#fff"/></svg>',
    '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="13.5" fill="#fff"/></svg>',
    '<svg viewBox="0 0 32 32"><rect x="4" y="4" width="24" height="24" rx="2" fill="#fff"/></svg>',
  ];
  const shape = (i) => h('span', { class: 'shape', html: SHAPE_SVG[i % 4] });

  const storage = {
    get(k, d = null) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch {}
    },
  };

  function toast(msg, type = '', ms = 2600) {
    let wrap = $('.toast-wrap');
    if (!wrap) document.body.append((wrap = h('div', { class: 'toast-wrap' })));
    const t = h('div', { class: 'toast ' + type }, msg);
    wrap.append(t);
    setTimeout(() => t.remove(), ms);
  }

  const fmt = (n) => Number(n || 0).toLocaleString('en-US');

  /** Promise wrapper around socket.emit with ack + timeout. */
  function emit(socket, ev, data, timeout = 8000) {
    return new Promise((resolve) => {
      socket.timeout(timeout).emit(ev, data, (err, res) => {
        resolve(err ? { error: '連線逾時，請再試一次' } : res || { error: '無回應' });
      });
    });
  }

  function connBanner(socket) {
    const b = h('div', { class: 'conn-banner', hidden: true }, '連線中斷，正在重新連線', h('span', { class: 'dots' }));
    document.body.append(b);
    let t;
    socket.on('disconnect', () => {
      clearTimeout(t);
      t = setTimeout(() => (b.hidden = false), 800);
    });
    socket.on('connect', () => {
      clearTimeout(t);
      b.hidden = true;
    });
  }

  // ---------------- Sound (synthesized with Web Audio, no assets) ----------------
  const Sound = {
    ctx: null,
    master: null,
    muted: storage.get('muted', false),
    musicTimer: null,
    musicKind: null,

    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.7;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    unlockOnGesture() {
      const f = () => {
        this.ensure();
        window.removeEventListener('pointerdown', f);
        window.removeEventListener('keydown', f);
      };
      window.addEventListener('pointerdown', f);
      window.addEventListener('keydown', f);
    },
    setMuted(m) {
      this.muted = m;
      storage.set('muted', m);
      if (this.master) this.master.gain.value = m ? 0 : 0.7;
    },
    tone(freq, at = 0, dur = 0.15, type = 'sine', vol = 0.25, slideTo = null) {
      const ctx = this.ensure();
      if (!ctx || this.muted) return;
      const t0 = ctx.currentTime + at;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(this.master);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    },
    noise(at = 0, dur = 0.08, vol = 0.2, hp = 1500) {
      const ctx = this.ensure();
      if (!ctx || this.muted) return;
      if (!this.noiseBuf) {
        const b = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        this.noiseBuf = b;
      }
      const t0 = ctx.currentTime + at;
      const s = ctx.createBufferSource();
      s.buffer = this.noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = hp;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      s.connect(f).connect(g).connect(this.master);
      s.start(t0);
      s.stop(t0 + dur + 0.02);
    },
    tick(urgent) {
      this.tone(urgent ? 1320 : 880, 0, 0.06, 'square', urgent ? 0.12 : 0.07);
    },
    pop() {
      this.tone(520, 0, 0.12, 'sine', 0.25, 1040);
    },
    click() {
      this.tone(660, 0, 0.05, 'triangle', 0.2);
    },
    correct() {
      [523, 659, 784, 1047].forEach((f, i) => this.tone(f, i * 0.08, 0.22, 'triangle', 0.3));
    },
    wrong() {
      this.tone(330, 0, 0.18, 'sawtooth', 0.15, 250);
      this.tone(247, 0.18, 0.35, 'sawtooth', 0.15, 160);
    },
    timeUp() {
      this.tone(880, 0, 0.12, 'square', 0.12);
      this.tone(660, 0.13, 0.12, 'square', 0.12);
      this.tone(440, 0.26, 0.35, 'square', 0.12);
    },
    gong() {
      [196, 247, 294, 392].forEach((f) => this.tone(f, 0, 1.4, 'sine', 0.18));
      this.noise(0, 0.25, 0.15, 3000);
    },
    whoosh() {
      this.noise(0, 0.3, 0.12, 800);
    },
    drumroll(sec) {
      const n = Math.floor(sec / 0.045);
      for (let i = 0; i < n; i++) this.noise(i * 0.045, 0.04, 0.05 + (0.18 * i) / n, 1200);
    },
    cymbal() {
      this.noise(0, 1.2, 0.35, 5000);
      this.tone(98, 0, 0.6, 'sine', 0.4);
    },
    fanfare() {
      const seq = [[523, 0, 0.15], [523, 0.16, 0.15], [523, 0.32, 0.15], [659, 0.48, 0.5], [587, 1.0, 0.2], [659, 1.2, 0.2], [784, 1.4, 0.9]];
      seq.forEach(([f, at, d]) => {
        this.tone(f, at, d, 'square', 0.12);
        this.tone(f / 2, at, d, 'triangle', 0.15);
      });
    },
    /** Tiny looping sequencer for background music. kind: 'lobby' | 'question' */
    music(kind) {
      if (this.musicKind === kind) return;
      this.stopMusic();
      const ctx = this.ensure();
      if (!ctx) return;
      this.musicKind = kind;
      const lobby = {
        bpm: 112,
        bass: [130.8, 0, 130.8, 0, 110, 0, 110, 0, 87.3, 0, 87.3, 0, 98, 0, 98, 0],
        lead: [523, 659, 784, 659, 440, 523, 659, 523, 349, 440, 523, 440, 392, 494, 587, 494],
        leadVol: 0.05,
      };
      const question = {
        bpm: 150,
        bass: [110, 110, 0, 110, 110, 0, 130.8, 0, 98, 98, 0, 98, 87.3, 0, 98, 0],
        lead: [880, 0, 659, 0, 880, 0, 659, 784, 784, 0, 587, 0, 784, 0, 587, 659],
        leadVol: 0.035,
      };
      const song = kind === 'question' ? question : lobby;
      const step = 60 / song.bpm / 2;
      let i = 0;
      let next = ctx.currentTime + 0.05;
      const schedule = () => {
        while (next < ctx.currentTime + 0.25) {
          const at = next - ctx.currentTime;
          const b = song.bass[i % 16];
          const l = song.lead[i % 16];
          if (b) this.tone(b, at, step * 0.9, 'triangle', 0.12);
          if (l) this.tone(l, at, step * 0.7, 'square', song.leadVol);
          if (kind === 'question' && i % 2 === 0) this.noise(at, 0.03, 0.03, 6000);
          next += step;
          i++;
        }
      };
      schedule();
      this.musicTimer = setInterval(schedule, 60);
    },
    stopMusic() {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
      this.musicKind = null;
    },
  };

  // ---------------- Confetti ----------------
  function confetti(durationMs = 4000, count = 180) {
    let canvas = $('#confetti');
    if (!canvas) document.body.append((canvas = h('canvas', { id: 'confetti' })));
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = innerWidth * dpr;
      canvas.height = innerHeight * dpr;
    };
    resize();
    const colors = ['#e21b3c', '#1368ce', '#d89e00', '#26890c', '#f5c518', '#ffffff', '#ff7ab6', '#7c3aed'];
    const parts = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: -Math.random() * canvas.height * 0.6,
      w: (6 + Math.random() * 8) * dpr,
      h: (8 + Math.random() * 10) * dpr,
      vx: (Math.random() - 0.5) * 3 * dpr,
      vy: (2 + Math.random() * 4) * dpr,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      c: colors[(Math.random() * colors.length) | 0],
    }));
    const end = performance.now() + durationMs;
    function frame(now) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = 0;
      for (const p of parts) {
        p.x += p.vx + Math.sin(p.y / (40 * dpr)) * dpr;
        p.y += p.vy;
        p.r += p.vr;
        if (p.y > canvas.height + 20) {
          if (now < end) {
            p.y = -20;
            p.x = Math.random() * canvas.width;
          } else continue;
        }
        alive++;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
        ctx.restore();
      }
      if (alive) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    requestAnimationFrame(frame);
  }

  // ---------------- Countdown ----------------
  /** Drives a countdown from a server-provided remainingMs. Calls onTick(secondsLeft, fractionLeft). */
  class Countdown {
    constructor(onTick, onEnd) {
      this.onTick = onTick;
      this.onEnd = onEnd;
      this.raf = null;
    }
    start(remainingMs, totalMs) {
      this.stop();
      const deadline = performance.now() + remainingMs;
      let lastSec = null;
      const loop = () => {
        const left = Math.max(0, deadline - performance.now());
        const sec = Math.ceil(left / 1000);
        this.onTick(sec, totalMs ? left / totalMs : 0, sec !== lastSec);
        lastSec = sec;
        if (left <= 0) {
          this.raf = null;
          if (this.onEnd) this.onEnd();
          return;
        }
        this.raf = requestAnimationFrame(loop);
      };
      loop();
    }
    stop() {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  function timerRing(size = 120) {
    const r = 54;
    const c = 2 * Math.PI * r;
    const el = h('div', { class: 'timer-ring', style: { width: size + 'px', height: size + 'px' } });
    el.innerHTML = `<svg viewBox="0 0 120 120"><circle class="bg" cx="60" cy="60" r="${r}" fill="none" stroke-width="10"/><circle class="fg" cx="60" cy="60" r="${r}" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="0"/></svg><div class="num"></div>`;
    const fg = el.querySelector('.fg');
    const num = el.querySelector('.num');
    el.update = (sec, frac) => {
      fg.style.strokeDashoffset = String(c * (1 - Math.max(0, Math.min(1, frac))));
      num.textContent = sec;
      el.classList.toggle('urgent', sec <= 5 && sec > 0);
    };
    return el;
  }

  /** Request a screen wake lock (keeps phones awake during a game). */
  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => (wakeLock = null));
      }
    } catch {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && window.__wantWake) keepAwake();
  });

  const TYPE_LABEL = { quiz: '單選題', multi: '複選題', tf: '是非題', text: '填空題', poll: '投票' };
  const AVATARS = ['🦊', '🐼', '🐸', '🐵', '🦁', '🐯', '🐨', '🐙', '🦄', '🐧', '🐳', '🦖', '🐝', '🦉', '🐹', '🐰', '🐶', '🐱', '🦋', '🐢', '🦀', '🐲', '🦜', '🐮'];

  window.K = { $, $$, h, shape, storage, toast, fmt, emit, connBanner, Sound, confetti, Countdown, timerRing, keepAwake, TYPE_LABEL, AVATARS };
})();
