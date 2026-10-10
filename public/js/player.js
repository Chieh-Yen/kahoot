(function () {
  'use strict';
  const { $, h, shape, storage, toast, fmt, emit, Sound, confetti, Countdown, keepAwake, TYPE_LABEL, AVATARS } = window.K;

  const app = $('#app');
  const socket = io();
  K.connBanner(socket);
  Sound.unlockOnGesture();

  let session = storage.get('player-session'); // { pin, token }
  let state = null; // last player:state
  let renderedKey = '';
  let local = null; // { qIndex, choice } optimistic answer
  let timeUp = false;
  let multiSel = new Set();
  let joinStep = null; // 'pin' | 'name' while in the join flow
  let pendingPin = null;
  let pendingTitle = '';
  const countdown = new Countdown(onTick, () => {
    if (state && state.phase === 'question' && !hasAnswered()) {
      timeUp = true;
      render(true);
    }
  });
  let timerEl = null;

  const urlPin = (new URLSearchParams(location.search).get('pin') || '').replace(/\D/g, '');

  function setScreen(...nodes) {
    app.replaceChildren(...nodes);
  }

  function clearSession() {
    session = null;
    storage.del('player-session');
  }

  // ---------------- join flow ----------------

  function showPinStep(prefill = '') {
    joinStep = 'pin';
    state = null;
    renderedKey = '';
    const input = h('input', {
      class: 'input pin-input', inputmode: 'numeric', autocomplete: 'off', placeholder: '遊戲 PIN', maxlength: 8, value: prefill,
    });
    const btn = h('button', { class: 'btn primary big block', type: 'submit' }, '進入');
    const form = h('form', { class: 'card join-card pop', onsubmit: async (e) => {
      e.preventDefault();
      const pin = input.value.replace(/\D/g, '');
      if (!pin) return input.focus();
      btn.disabled = true;
      const r = await emit(socket, 'player:check', { pin });
      btn.disabled = false;
      if (r.error) {
        toast(r.error, 'error');
        input.select();
        return;
      }
      pendingPin = pin;
      pendingTitle = r.title;
      showNameStep();
    } }, input, btn);
    setScreen(
      h('div', { class: 'center' },
        h('div', { class: 'logo' }, 'Quiz', h('span', null, 'Live')),
        form,
        h('div', { class: 'foot-links' }, h('a', { href: '/host' }, '我是主持人 →'))
      )
    );
    if (!prefill) setTimeout(() => input.focus(), 50);
  }

  function showNameStep() {
    joinStep = 'name';
    const last = storage.get('player-last', {});
    let avatar = AVATARS.includes(last.avatar) ? last.avatar : AVATARS[Math.floor(Math.random() * AVATARS.length)];
    const input = h('input', { class: 'input', placeholder: '你的暱稱', maxlength: 16, autocomplete: 'off', enterkeyhint: 'go', value: last.name || '' });
    const grid = h('div', { class: 'avatar-grid' },
      AVATARS.map((a) => h('button', { type: 'button', class: 'avatar-opt' + (a === avatar ? ' sel' : ''), onclick: (e) => {
        avatar = a;
        grid.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
        e.currentTarget.classList.add('sel');
      } }, a))
    );
    const btn = h('button', { class: 'btn primary big block', type: 'submit' }, '加入！');
    const form = h('form', { class: 'card join-card pop', onsubmit: async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return input.focus();
      btn.disabled = true;
      const r = await emit(socket, 'player:join', { pin: pendingPin, name, avatar });
      btn.disabled = false;
      if (r.error) {
        toast(r.error, 'error');
        if (/PIN|結束|鎖定|開始|已滿/.test(r.error)) showPinStep();
        return;
      }
      Sound.pop();
      storage.set('player-last', { name, avatar });
      session = { pin: pendingPin, token: r.token };
      storage.set('player-session', session);
      joinStep = null;
      window.__wantWake = true;
      keepAwake();
    } },
      h('div', { class: 'title' }, pendingTitle),
      h('label', { class: 'field-label' }, '暱稱'), input,
      h('label', { class: 'field-label' }, '選一個頭像'), grid,
      btn,
      h('button', { type: 'button', class: 'btn light sm', onclick: () => showPinStep() }, '← 換一個 PIN')
    );
    setScreen(h('div', { class: 'center' }, form));
    setTimeout(() => input.focus(), 50);
  }

  async function tryResume() {
    if (!session) return false;
    const r = await emit(socket, 'player:resume', session);
    if (r.error) {
      clearSession();
      return false;
    }
    window.__wantWake = true;
    keepAwake();
    return true;
  }

  socket.on('connect', async () => {
    if (joinStep) return; // keep the half-filled form across reconnects
    if (await tryResume()) return;
    if (urlPin) {
      const r = await emit(socket, 'player:check', { pin: urlPin });
      if (r.ok) {
        pendingPin = urlPin;
        pendingTitle = r.title;
        return showNameStep();
      }
      toast(r.error, 'error');
    }
    showPinStep(urlPin);
  });

  socket.on('player:state', (s) => {
    const prev = state;
    state = s;
    if (!prev || prev.qIndex !== s.qIndex || prev.phase !== s.phase) {
      if (s.phase !== 'question') timeUp = false;
      if (!prev || prev.qIndex !== s.qIndex) {
        local = null;
        multiSel = new Set();
        timeUp = false;
      }
    }
    render();
  });

  socket.on('player:kicked', () => {
    clearSession();
    countdown.stop();
    state = null;
    setScreen(h('div', { class: 'center' },
      h('div', { class: 'big-emoji' }, '🚪'),
      h('div', { class: 'headline' }, '你已被主持人移出遊戲'),
      h('button', { class: 'btn light', onclick: () => showPinStep() }, '回首頁')
    ));
  });

  socket.on('player:replaced', () => {
    countdown.stop();
    state = null;
    setScreen(h('div', { class: 'center' },
      h('div', { class: 'big-emoji' }, '📱'),
      h('div', { class: 'headline' }, '你在另一個分頁開啟了遊戲'),
      h('div', { class: 'sub' }, '請使用最新開啟的那個畫面繼續。'),
      h('button', { class: 'btn light', onclick: () => location.reload() }, '在這裡繼續')
    ));
  });

  // ---------------- rendering ----------------

  function hasAnswered() {
    return !!(state && (state.answered || (local && local.qIndex === state.qIndex)));
  }

  function bottomBar() {
    const me = state.me;
    return h('div', { class: 'bottombar' },
      h('span', { class: 'avatar' }, me.avatar),
      h('span', { class: 'name' }, me.name),
      h('span', { class: 'score' }, fmt(me.score))
    );
  }

  function topBar(withTimer) {
    const q = state.question;
    timerEl = withTimer ? h('span', { class: 'timer' }, '') : null;
    return h('div', { class: 'topbar' },
      h('span', { class: 'qnum' }, `${state.qIndex + 1} / ${state.total}`),
      q ? h('span', { class: 'type' }, TYPE_LABEL[q.type] + (q.points === 'double' ? ' · 雙倍分數' : '')) : null,
      h('span', { class: 'spacer' }),
      timerEl
    );
  }

  function onTick(sec, frac, changed) {
    if (timerEl) {
      timerEl.textContent = sec;
      timerEl.classList.toggle('urgent', sec <= 5);
    }
    const bar = $('.getready-bar > i');
    if (bar) bar.style.transform = `scaleX(${frac})`;
  }

  function render(force) {
    if (!state) return;
    const key = [state.phase, state.qIndex, hasAnswered(), timeUp].join('|');
    if (key === renderedKey && !force) {
      // Same screen: only refresh the score badge.
      const sc = $('.bottombar .score');
      if (sc) sc.textContent = fmt(state.me.score);
      return;
    }
    renderedKey = key;
    K.applyTextSize(app, state.question);
    countdown.stop();
    switch (state.phase) {
      case 'lobby': return renderLobby();
      case 'intro': return renderIntro();
      case 'question': return hasAnswered() ? renderAnswered() : timeUp ? renderTimeUp() : renderQuestion();
      case 'reveal': return renderResult();
      case 'scoreboard': return renderRank();
      case 'podium':
      case 'ended': return renderFinal();
    }
  }

  function renderLobby() {
    const me = state.me;
    setScreen(
      h('div', { class: 'center' },
        h('div', { class: 'big-emoji pop' }, me.avatar),
        h('div', { class: 'headline' }, '你加入了！'),
        h('div', { class: 'pill light' }, me.name),
        h('div', { class: 'sub' }, '在大螢幕上找找你的名字', h('br'), '等待主持人開始遊戲', h('span', { class: 'dots' })),
        h('div', { class: 'muted small', style: { color: 'rgba(255,255,255,.75)' } }, `${state.title} · 目前 ${state.playerCount} 人`),
        h('button', { class: 'btn ghost sm', onclick: async () => {
          const pin = state.pin;
          const title = state.title;
          await emit(socket, 'player:leave', {});
          clearSession();
          state = null;
          renderedKey = '';
          pendingPin = pin;
          pendingTitle = title;
          showNameStep();
        } }, '更換暱稱 / 頭像')
      ),
      bottomBar()
    );
  }

  function renderIntro() {
    const q = state.question;
    setScreen(
      topBar(false),
      h('div', { class: 'center' },
        h('div', { class: 'sub' }, `第 ${state.qIndex + 1} 題`),
        h('div', { class: 'headline pop intro-q' }, q.text || '準備好了嗎？'),
        h('div', { class: 'pill' }, TYPE_LABEL[q.type] + (q.points === 'double' ? ' · ⭐ 雙倍分數' : '')),
        h('div', { class: 'progress getready-bar' }, h('i'))
      ),
      bottomBar()
    );
    countdown.start(state.remainingMs, state.remainingMs);
  }

  function renderQuestion() {
    const q = state.question;
    const body = [];
    if (q.text) body.push(h('div', { class: 'qtext' }, q.text));
    if (q.type === 'text') {
      const input = h('input', { class: 'input', placeholder: '輸入答案', maxlength: 80, autocomplete: 'off', autocapitalize: 'off', enterkeyhint: 'send' });
      body.push(h('form', { class: 'text-answer', onsubmit: (e) => {
        e.preventDefault();
        if (input.value.trim()) submit(input.value.trim());
      } }, input, h('button', { class: 'btn primary big block', type: 'submit' }, '送出答案')));
      setTimeout(() => input.focus(), 50);
    } else {
      const n = q.optionCount;
      const multi = q.type === 'multi';
      const grid = h('div', { class: `answers n${n}` + (multi ? ' multi' : '') });
      const submitBtn = multi ? h('button', { class: 'btn light big multi-submit', disabled: true, onclick: () => submit([...multiSel]) }, '送出（已選 0 個）') : null;
      for (let i = 0; i < n; i++) {
        const label = q.options ? q.options[i] : null;
        const b = h('button', { class: `ans-btn ans-${i}` + (label ? ' has-text' : ''), 'aria-label': label || `選項 ${i + 1}`, onclick: () => {
          if (multi) {
            multiSel.has(i) ? multiSel.delete(i) : multiSel.add(i);
            b.classList.toggle('sel', multiSel.has(i));
            submitBtn.disabled = !multiSel.size;
            submitBtn.textContent = `送出（已選 ${multiSel.size} 個）`;
            Sound.click();
          } else submit(i);
        } }, shape(i), label);
        if (multi && multiSel.has(i)) b.classList.add('sel');
        grid.append(b);
      }
      body.push(grid);
      if (submitBtn) {
        submitBtn.disabled = !multiSel.size;
        submitBtn.textContent = `送出（已選 ${multiSel.size} 個）`;
        body.push(submitBtn);
      }
    }
    setScreen(topBar(true), ...body, bottomBar());
    countdown.start(state.remainingMs, q.timeLimit * 1000);
  }

  let submitting = false;
  async function submit(choice) {
    if (submitting || hasAnswered() || !state || state.phase !== 'question') return;
    submitting = true;
    const qIndex = state.qIndex;
    local = { qIndex, choice };
    Sound.click();
    if (navigator.vibrate) navigator.vibrate(25);
    render();
    const r = await emit(socket, 'player:answer', { qIndex, choice });
    submitting = false;
    if (r.error && !/已經作答/.test(r.error)) {
      toast(r.error, 'error');
      if (state && state.qIndex === qIndex && state.phase === 'question' && !state.answered) {
        local = null;
        render();
      }
    }
  }

  const WAIT_LINES = ['手速真快！', '答案已鎖定 🔒', '其他人還在想…', '你是直覺派還是推理派？', '屏息以待…'];
  function renderAnswered() {
    setScreen(
      topBar(true),
      h('div', { class: 'center' },
        h('div', { class: 'spinner' }),
        h('div', { class: 'headline' }, WAIT_LINES[(state.qIndex + state.me.name.length) % WAIT_LINES.length]),
        h('div', { class: 'sub' }, '等待其他玩家作答', h('span', { class: 'dots' }))
      ),
      bottomBar()
    );
    countdown.start(state.remainingMs, state.question.timeLimit * 1000);
  }

  function renderTimeUp() {
    setScreen(
      topBar(false),
      h('div', { class: 'center' }, h('div', { class: 'big-emoji' }, '⏰'), h('div', { class: 'headline' }, '時間到！'), h('div', { class: 'sub' }, '等待公布答案', h('span', { class: 'dots' }))),
      bottomBar()
    );
  }

  const GOOD = ['答對了！', '太神啦！', '完美！', '漂亮！', '你真行！'];
  const BAD = ['答錯了', '差一點點！', '下一題扳回來！', '沒關係，再接再厲！'];

  function renderResult() {
    const r = state.result || { answered: false, correct: false, points: 0, bonus: 0, streak: 0 };
    const pick = (arr) => arr[(state.qIndex * 7 + state.me.name.length) % arr.length];
    let cls, mark, title;
    if (state.isPoll) {
      cls = 'neutral'; mark = '🗳️'; title = r.answered ? '感謝你的投票！' : '這題是投票';
    } else if (r.correct) {
      cls = 'correct'; mark = '✓'; title = pick(GOOD);
    } else {
      cls = 'wrong'; mark = '✗'; title = r.answered ? pick(BAD) : '時間到！';
    }
    const gained = (r.points || 0) + (r.bonus || 0);
    const children = [
      h('div', { class: 'mark pop' }, mark),
      h('div', { class: 'headline' }, title),
    ];
    if (!state.isPoll) {
      if (r.correct) {
        children.push(h('div', { class: 'pill' }, '+ ' + fmt(gained)));
        if (r.streak >= 2) children.push(h('div', { class: 'streak' }, `🔥 連續答對 ${r.streak} 題` + (r.bonus ? `（連勝加分 +${r.bonus}）` : '')));
      } else {
        children.push(h('div', { class: 'sub' }, '連勝中斷，下一題加油！'));
        if (state.correctAnswer) children.push(h('div', { class: 'answer-was' }, '正確答案：' + state.correctAnswer));
      }
    }
    children.push(h('div', { class: 'sub' }, rankLine()));
    setScreen(h('div', { class: 'screen result ' + cls }, topBar(false), h('div', { class: 'center' }, children), bottomBar()));
    if (!state.isPoll) {
      r.correct ? Sound.correct() : Sound.wrong();
      if (navigator.vibrate) navigator.vibrate(r.correct ? [40, 40, 40] : 200);
    }
  }

  function rankLine() {
    const r = state.result;
    const me = state.me;
    if (me.rank === 1) return '🏆 你目前是第 1 名！';
    if (r && r.behind) return r.behind.gap > 0 ? `你目前第 ${me.rank} 名，落後「${r.behind.name}」${fmt(r.behind.gap)} 分` : `你目前第 ${me.rank} 名，與「${r.behind.name}」同分`;
    return `你目前第 ${me.rank} 名`;
  }

  function renderRank() {
    const me = state.me;
    setScreen(
      topBar(false),
      h('div', { class: 'center' },
        h('div', { class: 'sub' }, '目前排名'),
        h('div', { class: 'rank-big pop' }, `#${me.rank}`),
        h('div', { class: 'sub' }, `共 ${state.playerCount} 人`),
        h('div', { class: 'pill light' }, fmt(me.score) + ' 分'),
        me.streak >= 2 ? h('div', { class: 'streak' }, `🔥 連勝 ${me.streak}`) : null,
        h('div', { class: 'sub' }, state.qIndex + 1 < state.total ? '下一題馬上來！' : '')
      ),
      bottomBar()
    );
  }

  function renderFinal() {
    window.__wantWake = false;
    const f = state.final || { rank: state.me.rank, score: state.me.score, correctCount: 0 };
    const medal = ['🥇', '🥈', '🥉'][f.rank - 1];
    const msg = f.rank === 1 ? '冠軍！太強了！' : f.rank === 2 ? '亞軍！超棒的！' : f.rank === 3 ? '季軍！很厲害！' : f.rank <= 10 ? '進入前十名！' : '感謝參與！';
    // On the podium phase the host screen is still building suspense, so hold the medal briefly.
    const delay = state.phase === 'podium' && f.rank <= 3 ? [9000, 5200, 2600][f.rank - 1] : 0;
    const finalBody = () => [
      medal ? h('div', { class: 'medal' }, medal) : h('div', { class: 'big-emoji pop' }, '🎉'),
      h('div', { class: 'rank-big pop' }, `第 ${f.rank} 名`),
      h('div', { class: 'headline' }, msg),
      h('div', { class: 'pill light' }, fmt(f.score) + ' 分'),
      h('div', { class: 'sub' }, `答對 ${f.correctCount} / ${state.total} 題` + (f.bestStreak >= 2 ? ` · 最長連勝 ${f.bestStreak}` : '')),
      h('button', { class: 'btn ghost', onclick: () => { clearSession(); location.href = '/'; } }, '離開'),
    ];
    if (delay) {
      setScreen(h('div', { class: 'center' }, h('div', { class: 'big-emoji' }, '🥁'), h('div', { class: 'headline' }, '頒獎典禮進行中'), h('div', { class: 'sub' }, '請看大螢幕', h('span', { class: 'dots' }))), bottomBar());
      const key = renderedKey;
      setTimeout(() => {
        if (renderedKey !== key) return;
        setScreen(h('div', { class: 'center' }, finalBody()), bottomBar());
        confetti(5000);
        Sound.fanfare();
      }, delay);
    } else {
      setScreen(h('div', { class: 'center' }, finalBody()), bottomBar());
      if (f.rank <= 3) confetti(5000);
    }
  }
})();
