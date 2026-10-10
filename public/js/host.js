(function () {
  'use strict';
  const { $, h, shape, storage, toast, fmt, emit, Sound, confetti, Countdown, timerRing, TYPE_LABEL } = window.K;

  const app = $('#app');
  const socket = io();
  K.connBanner(socket);
  Sound.unlockOnGesture();

  let info = { needPassword: false, lanUrls: [], publicUrl: null };
  let password = storage.get('host-password', '');
  let session = storage.get('host-session'); // { pin, hostToken }
  let state = null;
  let renderedKey = '';
  let primary = null; // current primary action fn (Space / Enter)
  let ring = null;
  let timeouts = [];
  const chips = new Map();
  const countdown = new Countdown(onTick, onTimeEnd);
  const preselect = new URLSearchParams(location.search).get('quiz');

  const SETTINGS = [
    ['showOnDevice', '在玩家手機上顯示題目與選項', '遠距 / 線上遊戲或大螢幕看不清楚時很有用'],
    ['autoEndWhenAllAnswered', '全部人作答後立即結束倒數', ''],
    ['streakBonus', '連勝加分', '連續答對時每題額外 +100（最多 +500）'],
    ['allowLateJoin', '允許遊戲開始後加入', '晚到的人從 0 分開始'],
    ['shuffleQuestions', '隨機題目順序', ''],
    ['shuffleOptions', '隨機選項順序', '是非題不受影響'],
    ['autoAdvance', '自動播放', '公布答案與排行榜後自動進入下一步'],
  ];
  const NUM_SETTINGS = [
    ['introSeconds', '題目預覽秒數', 0, 15],
    ['autoAdvanceSeconds', '自動播放間隔（秒）', 3, 60],
    ['maxPlayers', '人數上限', 2, 1000],
  ];
  const DEFAULTS = {
    showOnDevice: true, autoEndWhenAllAnswered: true, streakBonus: true, allowLateJoin: true,
    shuffleQuestions: false, shuffleOptions: false, autoAdvance: false,
    introSeconds: 4, autoAdvanceSeconds: 8, maxPlayers: 300,
  };
  let settings = { ...DEFAULTS, ...storage.get('host-settings', {}) };

  function later(ms, fn) {
    timeouts.push(setTimeout(fn, ms));
  }
  function clearLater() {
    timeouts.forEach(clearTimeout);
    timeouts = [];
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'x-host-password': password, ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw Object.assign(new Error(data.error || '需要密碼'), { auth: true });
    if (!res.ok) throw new Error(data.error || '發生錯誤');
    return data;
  }

  function joinBase() {
    const override = storage.get('join-base');
    const opts = joinOptions();
    if (override && opts.includes(override)) return override;
    return opts[0];
  }
  function joinOptions() {
    const local = /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0)/.test(location.hostname);
    const list = [];
    if (info.publicUrl) list.push(info.publicUrl);
    if (!local) list.push(location.origin);
    list.push(...info.lanUrls);
    if (local) list.push(location.origin);
    return [...new Set(list)];
  }

  // ---------------- chrome: controls ----------------

  function controls(buttons) {
    const old = $('.host-controls');
    if (old) old.remove();
    const muteBtn = h('button', { class: 'btn ghost sm', title: '靜音 (M)', onclick: () => {
      Sound.setMuted(!Sound.muted);
      muteBtn.textContent = Sound.muted ? '🔇' : '🔊';
    } }, Sound.muted ? '🔇' : '🔊');
    const fsBtn = h('button', { class: 'btn ghost sm', title: '全螢幕 (F)', onclick: toggleFullscreen }, '⛶');
    document.body.append(h('div', { class: 'host-controls' }, buttons, muteBtn, fsBtn));
  }

  function cornerPin() {
    const old = $('.corner-pin');
    if (old) old.remove();
    if (!state || ['lobby', 'podium', 'ended'].includes(state.phase) || !state.settings.allowLateJoin || state.locked) return;
    document.body.append(h('div', { class: 'corner-pin' }, joinBase().replace(/^https?:\/\//, ''), ' · PIN ', h('b', null, state.pin)));
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  function setScreen(...nodes) {
    app.replaceChildren(...nodes);
  }

  async function next() {
    const r = await emit(socket, 'host:next', {});
    if (r.error) toast(r.error, 'error');
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') && primary) {
      e.preventDefault();
      primary();
    } else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    else if (e.key === 'm' || e.key === 'M') $('.host-controls .btn[title^="靜音"]')?.click();
  });

  // ---------------- setup / login ----------------

  function showLogin(msg) {
    primary = null;
    if (info.passwordMissing) {
      setScreen(h('div', { class: 'center' }, h('div', { class: 'card', style: { maxWidth: '520px' } },
        h('h2', { style: { marginTop: 0 } }, '尚未設定主持人密碼'),
        h('p', null, '這個伺服器跑在 Render 上，但還沒有設定 HOST_PASSWORD。為了避免任何人都能修改或刪除你的測驗，主持功能已暫停。'),
        h('p', null, '請到 Render → 你的服務 → Environment，新增 HOST_PASSWORD，儲存後會自動重新部署。'))));
      return;
    }
    const input = h('input', { class: 'input', type: 'password', placeholder: '主持人密碼', autocomplete: 'current-password' });
    setScreen(h('div', { class: 'center' },
      h('div', { class: 'logo' }, 'Quiz', h('span', null, 'Live')),
      h('form', { class: 'card join-card', style: { width: 'min(92vw,380px)', display: 'flex', flexDirection: 'column', gap: '12px' }, onsubmit: async (e) => {
        e.preventDefault();
        password = input.value;
        try {
          await api('/api/auth', { method: 'POST', body: JSON.stringify({ password }) });
          storage.set('host-password', password);
          showSetup();
        } catch (err) {
          toast(err.message, 'error');
        }
      } }, msg ? h('div', { class: 'muted' }, msg) : null, input, h('button', { class: 'btn primary big block' }, '登入'))
    ));
    controls([]);
    setTimeout(() => input.focus(), 50);
  }

  async function showSetup() {
    state = null;
    renderedKey = '';
    primary = null;
    countdown.stop();
    clearLater();
    Sound.stopMusic();
    $('.corner-pin')?.remove();
    let quizzes;
    try {
      quizzes = await api('/api/quizzes');
      const restored = await K.QuizBackup.restoreMissing(quizzes, password);
      if (restored) {
        quizzes = await api('/api/quizzes');
        toast(`已從這台電腦的備份還原 ${restored} 份測驗`, 'success', 4000);
      }
    } catch (e) {
      if (e.auth || info.passwordMissing) return showLogin(password ? '密碼錯誤，請重新輸入' : '');
      return toast(e.message, 'error', 8000);
    }

    const grid = h('div', { class: 'quiz-grid' });
    for (const q of quizzes) {
      grid.append(h('div', { class: 'card quiz-card' + (q.id === preselect ? ' highlight' : '') },
        h('h3', null, q.title),
        h('p', null, q.description || ''),
        h('div', { class: 'meta' }, `${q.questionCount} 題` + (q.updatedAt ? ' · 更新於 ' + new Date(q.updatedAt).toLocaleDateString() : '')),
        h('div', { class: 'row' },
          h('button', { class: 'btn accent', onclick: (e) => startGame(q.id, e.currentTarget) }, '▶ 開始遊戲'),
          h('a', { class: 'btn light sm', href: '/editor#' + q.id }, '編輯')
        )
      ));
    }
    if (!quizzes.length) grid.append(h('div', { class: 'card empty-state' }, '還沒有任何測驗。', h('br'), h('a', { href: '/editor' }, '前往題目編輯器建立一份 →')));

    const sBox = h('div', { class: 'settings' });
    for (const [k, label, desc] of SETTINGS) {
      sBox.append(h('label', { class: 'setting' },
        h('input', { type: 'checkbox', checked: !!settings[k], onchange: (e) => { settings[k] = e.target.checked; storage.set('host-settings', settings); } }),
        h('div', null, h('b', null, label), desc ? h('span', null, desc) : null)
      ));
    }
    for (const [k, label, lo, hi] of NUM_SETTINGS) {
      sBox.append(h('label', { class: 'setting' },
        h('input', { type: 'number', min: lo, max: hi, value: settings[k], onchange: (e) => {
          settings[k] = Math.min(hi, Math.max(lo, parseInt(e.target.value, 10) || DEFAULTS[k]));
          e.target.value = settings[k];
          storage.set('host-settings', settings);
        } }),
        h('div', null, h('b', null, label))
      ));
    }

    setScreen(h('div', { class: 'setup' },
      h('header', null,
        h('div', { class: 'logo' }, 'Quiz', h('span', null, 'Live')),
        h('span', { class: 'spacer' }),
        h('a', { class: 'btn light', href: '/editor' }, '✏️ 題目編輯器'),
        info.needPassword ? h('button', { class: 'btn ghost sm', onclick: () => { storage.del('host-password'); password = ''; showLogin(); } }, '登出') : null
      ),
      h('h2', null, '選擇測驗'),
      grid,
      h('h2', null, '遊戲設定'),
      h('div', { class: 'card' }, sBox)
    ));
    controls([]);
  }

  async function startGame(quizId, btn) {
    Sound.ensure();
    // Back up the quiz we are about to play, so a server restart can't lose it.
    api('/api/quizzes/' + encodeURIComponent(quizId)).then((doc) => K.QuizBackup.save(doc)).catch(() => {});
    if (btn) btn.disabled = true;
    const r = await emit(socket, 'host:create', { quizId, settings, password });
    if (btn) btn.disabled = false;
    if (r.error) return toast(r.error, 'error');
    session = { pin: r.pin, hostToken: r.hostToken };
    storage.set('host-session', session);
    history.replaceState(null, '', '/host');
  }

  async function newGame() {
    if (state && state.phase !== 'ended' && state.phase !== 'podium') {
      if (!confirm('確定要結束目前的遊戲嗎？')) return;
      await emit(socket, 'host:end', {});
    }
    session = null;
    storage.del('host-session');
    showSetup();
  }

  // ---------------- socket ----------------

  socket.on('connect', async () => {
    await infoReady;
    if (session) {
      const r = await emit(socket, 'host:resume', session);
      if (!r.error) return;
      session = null;
      storage.del('host-session');
    }
    if (!state) showSetup();
  });

  socket.on('host:state', (s) => {
    state = s;
    render();
  });

  // ---------------- render ----------------

  function render() {
    const key = state.phase + '|' + state.qIndex;
    const same = key === renderedKey;
    renderedKey = key;
    cornerPin();
    switch (state.phase) {
      case 'lobby': return same ? updateLobby() : renderLobby();
      case 'intro': return same ? null : renderIntro();
      case 'question': return same ? updateQuestion() : renderQuestion();
      case 'reveal': return same ? null : renderReveal();
      case 'scoreboard': return same ? null : renderScoreboard();
      case 'podium': return same ? null : renderPodium();
      case 'ended': return same ? null : renderResults();
    }
  }

  function leaveScreen() {
    K.applyTextSize(app, state && state.question);
    countdown.stop();
    clearLater();
    ring = null;
  }

  // ----- lobby -----
  function renderLobby() {
    leaveScreen();
    Sound.music('lobby');
    chips.clear();
    const base = joinBase();
    const joinUrl = base + '/?pin=' + state.pin;
    const qrSrc = '/api/qr.svg?text=' + encodeURIComponent(joinUrl);
    const urlEl = h('div', { class: 'url', title: '點擊切換網址', style: { cursor: joinOptions().length > 1 ? 'pointer' : 'default' }, onclick: () => {
      const opts = joinOptions();
      if (opts.length < 2) return;
      storage.set('join-base', opts[(opts.indexOf(joinBase()) + 1) % opts.length]);
      renderLobby();
    } }, base.replace(/^https?:\/\//, ''));
    setScreen(
      h('div', { class: 'lobby-top' },
        h('div', { class: 'join-box' }, h('div', { class: 'lbl' }, '用手機瀏覽器開啟'), urlEl),
        h('div', { class: 'join-box' }, h('div', { class: 'lbl' }, '遊戲 PIN：'), h('div', { class: 'pin' }, state.pin.replace(/(\d{3})(\d{3})/, '$1 $2'))),
        h('div', { class: 'qr-box', title: '點擊放大', onclick: () => {
          document.body.append(h('div', { class: 'qr-modal', onclick: (e) => e.currentTarget.remove() }, h('img', { src: qrSrc, alt: 'QR code' })));
        } }, h('img', { src: qrSrc, alt: 'QR code' }))
      ),
      h('div', { class: 'lobby-bar' },
        h('div', { class: 'count-badge', id: 'count' }, ''),
        h('div', { class: 'lobby-title' }, state.title),
      ),
      h('div', { class: 'players', id: 'players' })
    );
    updateLobby();
  }

  function updateLobby() {
    const players = state.players || [];
    $('#count').textContent = `👥 ${players.length}`;
    const box = $('#players');
    box.classList.toggle('dense', players.length > 40);
    const ids = new Set(players.map((p) => p.id));
    for (const [id, el] of chips) if (!ids.has(id)) { el.remove(); chips.delete(id); }
    let added = 0;
    for (const p of players) {
      let el = chips.get(p.id);
      if (!el) {
        el = h('div', { class: 'chip new', title: '點擊移出', onclick: () => kick(p) }, h('span', null, p.avatar), p.name);
        chips.set(p.id, el);
        box.append(el);
        added++;
      }
      el.classList.toggle('off', !p.connected);
    }
    if (added) Sound.pop();
    $('.waiting', box)?.remove();
    if (!players.length) box.append(h('div', { class: 'waiting' }, '等待玩家加入', h('span', { class: 'dots' })));
    controls([
      h('button', { class: 'btn ghost sm', onclick: () => emit(socket, 'host:lock', { locked: !state.locked }) }, state.locked ? '🔒 已鎖定' : '🔓 開放加入'),
      h('button', { class: 'btn ghost sm', onclick: newGame }, '取消'),
      h('button', { class: 'btn light', disabled: !players.length, onclick: next }, '開始遊戲 ▶'),
    ]);
    primary = players.length ? next : null;
  }

  async function kick(p) {
    if (!confirm(`將「${p.name}」移出遊戲？`)) return;
    const r = await emit(socket, 'host:kick', { playerId: p.id });
    if (r.error) toast(r.error, 'error');
  }

  // ----- intro -----
  function renderIntro() {
    leaveScreen();
    Sound.stopMusic();
    Sound.whoosh();
    const q = state.question;
    const bar = h('i');
    setScreen(h('div', { class: 'intro' },
      h('div', { class: 'num' }, `第 ${state.qIndex + 1} / ${state.total} 題 · ${TYPE_LABEL[q.type]}`),
      q.points === 'double' ? h('div', { class: 'pill', style: { background: 'var(--gold)', color: '#5a4200', padding: '8px 20px', borderRadius: '99px', fontWeight: 900, fontSize: '22px' } }, '⭐ 雙倍分數') : null,
      h('div', { class: 'text pop' }, q.text),
      h('div', { class: 'progress' }, bar)
    ));
    const total = state.remainingMs;
    const t0 = performance.now();
    const step = () => {
      const f = Math.max(0, 1 - (performance.now() - t0) / total);
      bar.style.transform = `scaleX(${f})`;
      if (f > 0 && state.phase === 'intro') requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    controls([autoToggle(), endBtn(), h('button', { class: 'btn light', onclick: next }, '跳過 ▶')]);
    primary = next;
  }

  function autoToggle() {
    const cb = h('input', { type: 'checkbox', checked: state.settings.autoAdvance, onchange: (e) => emit(socket, 'host:autoAdvance', { on: e.target.checked }) });
    return h('label', { class: 'toggle', title: '公布答案與排行榜後自動繼續' }, cb, '自動播放');
  }
  function endBtn() {
    return h('button', { class: 'btn ghost sm', title: '提前結束遊戲並公布成績', onclick: async () => {
      if (!confirm('提前結束遊戲並直接公布最終成績？')) return;
      await emit(socket, 'host:end', {});
    } }, '⏏ 結束');
  }

  // ----- question / reveal -----
  function questionHead(q) {
    return [
      h('div', { class: 'q-head' }, q.text),
      h('div', { class: 'q-meta' },
        h('span', { class: 'pill' }, `${state.qIndex + 1} / ${state.total}`),
        h('span', { class: 'pill' }, TYPE_LABEL[q.type]),
        q.points === 'double' ? h('span', { class: 'pill', style: { background: 'var(--gold)', color: '#5a4200' } }, '⭐ 雙倍分數') : null,
        q.points === 'none' && q.type !== 'poll' ? h('span', { class: 'pill' }, '不計分') : null
      ),
    ];
  }

  function tiles(q, revealMode) {
    if (q.type === 'text') return null;
    const box = h('div', { class: `tiles n${q.options.length}` });
    q.options.forEach((o, i) => {
      const isCorrect = q.correct && q.correct.includes(i);
      const dim = revealMode && q.type !== 'poll' && !isCorrect;
      box.append(h('div', { class: `tile ans-${i}` + (dim ? ' dim' : '') }, shape(i), h('span', { class: 'txt' }, o), revealMode && isCorrect ? h('span', { class: 'tick' }, '✓') : null));
    });
    return box;
  }

  function mediaBox(q) {
    if (q.image) return h('div', { class: 'q-media' }, h('img', { src: q.image, alt: '' }));
    const hint = { text: '✍️ 請在手機上輸入答案', multi: '☑️ 可以選擇多個答案', poll: '🗳️ 投下你的一票', tf: '⭕ 是 或 ❌ 非？', quiz: '' }[q.type];
    return h('div', { class: 'q-media' }, h('div', { class: 'type-hint' }, hint));
  }

  function renderQuestion() {
    leaveScreen();
    const q = state.question;
    Sound.music('question');
    ring = timerRing(150);
    setScreen(
      ...questionHead(q),
      h('div', { class: 'q-mid' },
        h('div', { class: 'side' }, ring),
        mediaBox(q),
        h('div', { class: 'side' }, h('div', { class: 'answered-count', id: 'acount' }, '0'), h('div', { class: 'answered-label', id: 'alabel' }, '人已作答'))
      ),
      tiles(q, false) || h('div', { style: { height: '74px' } })
    );
    countdown.start(state.remainingMs, q.timeLimit * 1000);
    controls([autoToggle(), endBtn(), h('button', { class: 'btn light', onclick: next }, '⏹ 結束作答')]);
    primary = next;
    updateQuestion();
  }

  function updateQuestion() {
    const el = $('#acount');
    if (!el) return;
    if (el.textContent !== String(state.answeredCount)) {
      el.textContent = state.answeredCount;
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
    }
    $('#alabel').textContent = `/ ${state.connectedCount} 人已作答`;
  }

  function onTick(sec, frac, changed) {
    if (ring) ring.update(sec, frac);
    if (changed && state && state.phase === 'question' && sec <= 5 && sec > 0) Sound.tick(sec <= 3);
  }
  function onTimeEnd() {
    if (state && state.phase === 'question') {
      Sound.stopMusic();
      Sound.timeUp();
    }
  }

  function renderReveal() {
    leaveScreen();
    Sound.stopMusic();
    Sound.gong();
    const q = state.question;
    const rv = state.reveal;
    let center;
    if (q.type === 'text') {
      center = h('div', { class: 'text-answers' },
        h('div', { class: 'accepted' }, '✓ 正確答案：' + q.accepted.join(' / ')),
        rv.textAnswers.slice(0, 6).map((a) => h('div', { class: 'ta-row' + (a.correct ? ' ok' : '') }, h('span', { class: 'ic' }, a.correct ? '✅' : '❌'), h('span', { class: 'txt' }, a.text), h('b', null, a.count)))
      );
    } else {
      const max = Math.max(1, ...rv.counts);
      const bars = q.options.map((o, i) => {
        const ok = q.type === 'poll' || q.correct.includes(i);
        const col = h('div', { class: `col ans-${i}`, style: { height: '0%' } });
        later(60, () => (col.style.height = Math.max(2, (rv.counts[i] / max) * 80) + '%'));
        return h('div', { class: 'bar' + (ok ? '' : ' dim') },
          h('div', { class: 'stack' }, h('div', { class: 'n' }, rv.counts[i]), col),
          h('div', { class: `foot ans-${i}` }, shape(i), q.type !== 'poll' && ok ? '✓' : '')
        );
      });
      center = h('div', { class: 'chart', style: { height: '32vh' } }, bars);
    }
    const pct = rv.totalPlayers ? Math.round((rv.correctPlayers / rv.totalPlayers) * 100) : 0;
    const stat = q.type === 'poll' ? `${rv.answered} 人投票` : `${rv.correctPlayers} / ${rv.totalPlayers} 人答對（${pct}%）`;
    setScreen(
      ...questionHead(q),
      h('div', { class: 'q-mid', style: { gridTemplateColumns: '1fr' } }, h('div', null, center, h('div', { class: 'stat-line', style: { marginTop: '14px' } }, stat))),
      tiles(q, true) || h('div', { style: { height: '74px' } })
    );
    const last = state.qIndex >= state.total - 1;
    controls([autoToggle(), endBtn(), h('button', { class: 'btn light', onclick: next }, last ? '🏆 頒獎典禮' : '排行榜 ▶')]);
    primary = next;
  }

  // ----- scoreboard -----
  function renderScoreboard() {
    leaveScreen();
    Sound.music('lobby');
    const rows = state.scoreboard;
    const ROW = 84;
    const board = h('div', { class: 'board', style: { height: rows.length * ROW + 'px' } });
    // Start in previous order, then animate into new order.
    const prevOrder = [...rows].sort((a, b) => a.prevRank - b.prevRank);
    rows.forEach((r) => {
      const moved = r.prevRank - r.rank;
      const scoreEl = h('span', null, fmt(r.score - r.gained));
      const el = h('div', { class: 'brow' },
        h('span', { class: 'rk' }, r.rank),
        h('span', { class: 'av avatar' }, r.avatar),
        h('span', { class: 'nm' }, r.name),
        r.streak >= 2 ? h('span', { class: 'st', title: '連勝' }, '🔥' + r.streak) : null,
        h('span', { class: 'mv ' + (moved > 0 ? 'up' : moved < 0 ? 'down' : '') }, moved > 0 ? '▲' + moved : moved < 0 ? '▼' + -moved : ''),
        r.gained ? h('span', { class: 'gain' }, '+' + fmt(r.gained)) : null,
        scoreEl
      );
      const startIdx = prevOrder.indexOf(r);
      el.style.top = startIdx * ROW + 'px';
      board.append(el);
      later(900, () => (el.style.top = (r.rank - 1) * ROW + 'px'));
      later(500, () => countUp(scoreEl, r.score - r.gained, r.score, 900));
    });
    setScreen(h('div', { class: 'board-wrap' }, h('div', { class: 'board-title slide-up' }, '🏅 排行榜'), board,
      h('div', { class: 'sub', style: { marginTop: '24px', fontWeight: 800, opacity: 0.9 } }, `第 ${state.qIndex + 1} / ${state.total} 題結束 · ${state.playerCount} 位玩家`)));
    controls([autoToggle(), endBtn(), h('button', { class: 'btn light', onclick: next }, '下一題 ▶')]);
    primary = next;
  }

  function countUp(el, from, to, ms) {
    const t0 = performance.now();
    const step = (now) => {
      const f = Math.min(1, (now - t0) / ms);
      el.textContent = fmt(Math.round(from + (to - from) * (1 - Math.pow(1 - f, 3))));
      if (f < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ----- podium -----
  function renderPodium() {
    leaveScreen();
    Sound.stopMusic();
    const top = state.ranking.slice(0, 3);
    const pod = (place) => {
      const p = top[place - 1];
      return h('div', { class: `pod p${place}`, id: 'pod' + place },
        h('div', { class: 'who' },
          place === 1 ? h('div', { class: 'crown' }, '👑') : null,
          p ? h('div', { class: 'av' }, p.avatar) : null,
          p ? h('div', { class: 'nm' }, p.name) : h('div', { class: 'nm' }, '—'),
          p ? h('div', { class: 'sc' }, fmt(p.score) + ' 分') : null,
          p ? h('div', { class: 'cc' }, `答對 ${p.correctCount} / ${state.total} 題`) : null
        ),
        h('div', { class: 'block' }, ['🥇', '🥈', '🥉'][place - 1])
      );
    };
    const actions = h('div', { class: 'podium-actions' },
      h('button', { class: 'btn light', onclick: next }, '📊 完整成績'),
      h('button', { class: 'btn ghost', onclick: () => renderPodium() }, '🔁 重播頒獎')
    );
    setScreen(
      h('div', { class: 'spotlight' }),
      h('div', { class: 'podium-wrap' },
        h('div', { class: 'podium-title slide-up' }, '🏆 頒獎典禮'),
        h('div', { class: 'sub', style: { fontWeight: 800, opacity: 0.85 } }, state.title),
        h('div', { class: 'podium' }, pod(2), pod(1), pod(3)),
        actions
      )
    );
    const reveal = (place, big) => {
      const el = $('#pod' + place);
      if (!el) return;
      el.classList.add('raised');
      later(500, () => el.classList.add('show'));
      if (big) {
        Sound.cymbal();
        later(300, () => Sound.fanfare());
        later(400, () => confetti(9000, 260));
      } else later(450, () => Sound.gong());
    };
    later(500, () => Sound.drumroll(1.6));
    later(2100, () => reveal(3));
    later(3200, () => Sound.drumroll(1.6));
    later(4700, () => reveal(2));
    later(5800, () => Sound.drumroll(2.6));
    later(8500, () => reveal(1, true));
    later(10500, () => {
      actions.classList.add('show');
      Sound.music('lobby');
    });
    controls([]);
    primary = () => {
      // First press skips the animation, second goes to results.
      if (!actions.classList.contains('show')) {
        clearLater();
        [3, 2, 1].forEach((p) => $('#pod' + p)?.classList.add('raised', 'show'));
        actions.classList.add('show');
      } else next();
    };
  }

  // ----- results -----
  function renderResults() {
    leaveScreen();
    Sound.music('lobby');
    primary = null;
    const ranking = state.ranking || [];
    const dl = (ext) => `/api/games/${state.pin}/results.${ext}?token=${encodeURIComponent(session ? session.hostToken : '')}`;
    const table = h('table', { class: 'rtable' },
      h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, '玩家'), h('th', { style: { textAlign: 'right' } }, '分數'), h('th', { style: { textAlign: 'right' } }, '答對'), h('th', { style: { textAlign: 'right' } }, '最長連勝'))),
      h('tbody', null, ranking.map((p) => h('tr', null,
        h('td', null, ['🥇', '🥈', '🥉'][p.rank - 1] || p.rank),
        h('td', null, p.avatar + ' ' + p.name),
        h('td', { class: 'num' }, fmt(p.score)),
        h('td', { class: 'num' }, `${p.correctCount}`),
        h('td', { class: 'num' }, p.bestStreak)
      )))
    );
    const stats = (state.stats || []).map((s, i) => {
      const pct = ranking.length ? Math.round((s.correct / ranking.length) * 100) : 0;
      return h('div', { class: 'qstat' },
        h('div', { class: 't' }, `Q${i + 1}. ${s.text}`),
        s.type === 'poll'
          ? h('div', { class: 'pct' }, `投票 · ${s.answered} 人參與`)
          : [h('div', { class: 'meter' }, h('i', { style: { width: pct + '%' } })), h('div', { class: 'pct' }, `${pct}% 答對 · ${s.answered} 人作答`)]
      );
    });
    const hard = (state.stats || []).map((s, i) => ({ ...s, i })).filter((s) => s.type !== 'poll' && ranking.length).sort((a, b) => a.correct - b.correct)[0];
    setScreen(h('div', { class: 'results' },
      h('div', { class: 'card' },
        h('div', { class: 'row', style: { marginBottom: '12px' } }, h('h2', { style: { margin: 0 } }, '最終成績'), h('span', { class: 'spacer' }), h('span', { class: 'muted' }, `${state.title} · ${ranking.length} 人`)),
        h('div', { class: 'scroll-y' }, table)
      ),
      h('div', { class: 'card' },
        h('h2', null, '題目分析'),
        hard ? h('div', { class: 'muted small', style: { marginBottom: '12px' } }, `最難的一題：Q${hard.i + 1}（${ranking.length ? Math.round((hard.correct / ranking.length) * 100) : 0}% 答對）`) : null,
        h('div', { class: 'scroll-y' }, stats),
        h('div', { class: 'row wrap', style: { marginTop: '14px' } },
          h('a', { class: 'btn ok sm', href: dl('csv') }, '⬇ 下載 CSV'),
          h('a', { class: 'btn primary sm', href: dl('json') }, '⬇ 下載 JSON')
        )
      )
    ));
    controls([h('button', { class: 'btn light', onclick: newGame }, '🎮 開新遊戲')]);
  }

  // ---------------- boot ----------------
  K.keepServerAwake();
  // The socket 'connect' handler waits for this, then drives the rest (resume or setup).
  var infoReady = fetch('/api/info')
    .then((r) => r.json())
    .then((i) => (info = i))
    .catch(() => {});
})();
