'use strict';
// Authoritative game engine. All timing and scoring happen here; clients only render snapshots.

const crypto = require('crypto');
const { POINTS, normalizeAnswerText } = require('./quiz');

const PHASES = ['lobby', 'intro', 'question', 'reveal', 'scoreboard', 'podium', 'ended'];
const ANSWER_GRACE_MS = 600; // accept answers that were in flight when the timer hit zero
const MAX_NAME = 16;
const AVATARS = ['🦊', '🐼', '🐸', '🐵', '🦁', '🐯', '🐨', '🐙', '🦄', '🐧', '🐳', '🦖', '🐝', '🦉', '🐹', '🐰', '🐶', '🐱', '🦋', '🐢', '🦀', '🐲', '🦜', '🐮'];

const DEFAULT_SETTINGS = {
  shuffleQuestions: false,
  shuffleOptions: false,
  showOnDevice: true,
  streakBonus: true,
  autoEndWhenAllAnswered: true,
  allowLateJoin: true,
  introSeconds: 10,
  autoAdvance: false,
  autoAdvanceSeconds: 8,
  maxPlayers: 300,
};

function sanitizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS };
  raw = raw || {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof DEFAULT_SETTINGS[k] === 'boolean' && typeof raw[k] === 'boolean') s[k] = raw[k];
  }
  const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d);
  s.introSeconds = num(raw.introSeconds, 0, 15, s.introSeconds);
  s.autoAdvanceSeconds = num(raw.autoAdvanceSeconds, 3, 60, s.autoAdvanceSeconds);
  s.maxPlayers = num(raw.maxPlayers, 2, 1000, s.maxPlayers);
  return s;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cleanName(raw) {
  // Strip control / zero-width chars, collapse whitespace, cap by code points.
  const s = String(raw == null ? '' : raw)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, MAX_NAME).join('');
}

function scoreFor(base, elapsedMs, limitMs) {
  if (!base) return 0;
  const frac = Math.min(1, Math.max(0, elapsedMs / limitMs));
  return Math.round(base * (1 - frac / 2));
}

function streakBonusFor(streak) {
  return streak >= 2 ? Math.min(streak - 1, 5) * 100 : 0;
}

class Game {
  /**
   * @param {object} o
   * @param {string} o.pin
   * @param {object} o.quiz normalized quiz
   * @param {object} o.settings
   * @param {{toHost:Function,toSocket:Function}} o.transport
   * @param {Function} [o.now]
   * @param {Function} [o.onFinish] called with results when the podium is reached
   */
  constructor({ pin, quiz, settings, transport, now = Date.now, onFinish = () => {} }) {
    this.pin = pin;
    this.hostToken = crypto.randomBytes(18).toString('base64url');
    this.settings = sanitizeSettings(settings);
    this.transport = transport;
    this.now = now;
    this.onFinish = onFinish;
    this.createdAt = now();
    this.lastActivity = this.createdAt;

    this.title = quiz.title;
    this.questions = this.prepareQuestions(quiz.questions);
    this.phase = 'lobby';
    this.qIndex = -1;
    this.locked = false;
    this.players = new Map(); // id -> player
    this.byToken = new Map(); // token -> player
    this.kickedNames = new Set();
    this.answers = new Map(); // playerId -> answer record for current question
    this.timer = null;
    this.hostFlushTimer = null;
    this.phaseEndsAt = 0;
    this.startedAt = 0;
    this.reveal = null;
    this.finalRanking = null;
  }

  prepareQuestions(qs) {
    let list = qs.map((q) => JSON.parse(JSON.stringify(q)));
    if (this.settings.shuffleQuestions) list = shuffle(list);
    for (const q of list) {
      if (this.settings.shuffleOptions && (q.type === 'quiz' || q.type === 'multi' || q.type === 'poll')) {
        const order = shuffle(q.options.map((_, i) => i));
        q.options = order.map((i) => q.options[i]);
        q.correct = q.correct.map((c) => order.indexOf(c)).sort();
      }
      if (q.type === 'text') q.acceptedNorm = q.accepted.map(normalizeAnswerText);
    }
    return list;
  }

  get question() {
    return this.questions[this.qIndex] || null;
  }

  touch() {
    this.lastActivity = this.now();
  }

  // ---------- players ----------

  activePlayers() {
    return [...this.players.values()];
  }

  connectedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  canJoin() {
    if (this.phase === 'podium' || this.phase === 'ended') return '遊戲已經結束';
    if (this.locked) return '主持人已鎖定房間';
    if (this.phase !== 'lobby' && !this.settings.allowLateJoin) return '遊戲已經開始，無法加入';
    if (this.players.size >= this.settings.maxPlayers) return '房間人數已滿';
    return null;
  }

  join(rawName, rawAvatar, socketId) {
    const blocked = this.canJoin();
    if (blocked) return { error: blocked };
    const name = cleanName(rawName);
    if (!name) return { error: '請輸入暱稱' };
    const key = name.toLowerCase();
    if (this.kickedNames.has(key)) return { error: '這個暱稱無法使用' };
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === key) return { error: '這個暱稱已經有人使用了' };
    }
    const avatar = AVATARS.includes(rawAvatar) ? rawAvatar : AVATARS[crypto.randomInt(AVATARS.length)];
    const p = {
      id: crypto.randomBytes(6).toString('hex'),
      token: crypto.randomBytes(18).toString('base64url'),
      name,
      avatar,
      score: 0,
      streak: 0,
      bestStreak: 0,
      correctCount: 0,
      correctTime: 0,
      rank: 0,
      prevRank: 0,
      lastResult: null,
      history: [],
      socketId,
      connected: true,
      joinedAt: this.now(),
      joinedAtQuestion: this.qIndex,
    };
    this.players.set(p.id, p);
    this.byToken.set(p.token, p);
    if (this.phase !== 'lobby') this.rank(); // late joiners get a rank immediately
    this.touch();
    this.scheduleHostUpdate();
    return { player: p };
  }

  resume(token, socketId) {
    const p = this.byToken.get(token);
    if (!p) return { error: '找不到玩家資料' };
    const oldSocket = p.connected && p.socketId !== socketId ? p.socketId : null;
    p.socketId = socketId;
    p.connected = true;
    this.touch();
    this.scheduleHostUpdate();
    return { player: p, oldSocket };
  }

  disconnect(socketId) {
    for (const p of this.players.values()) {
      if (p.socketId === socketId && p.connected) {
        p.connected = false;
        this.scheduleHostUpdate();
        // A disconnect may mean everyone remaining has answered.
        if (this.phase === 'question') this.maybeEndEarly();
        return p;
      }
    }
    return null;
  }

  kick(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    this.players.delete(p.id);
    this.byToken.delete(p.token);
    this.answers.delete(p.id);
    this.kickedNames.add(p.name.toLowerCase());
    if (p.connected) this.transport.toSocket(p.socketId, 'player:kicked', {});
    if (this.phase !== 'lobby') this.rank();
    this.scheduleHostUpdate();
    if (this.phase === 'question') this.maybeEndEarly();
    return p;
  }

  /** Voluntary leave (e.g. "change nickname" in the lobby). No ban, unlike kick. */
  leave(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    this.players.delete(p.id);
    this.byToken.delete(p.token);
    this.answers.delete(p.id);
    if (this.phase !== 'lobby') this.rank();
    this.scheduleHostUpdate();
    if (this.phase === 'question') this.maybeEndEarly();
    return p;
  }

  setLocked(v) {
    this.locked = !!v;
    this.pushHost();
  }

  // ---------- flow ----------

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  later(ms, fn) {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, Math.max(0, ms));
  }

  /** The host's single "advance" button. */
  next() {
    this.touch();
    switch (this.phase) {
      case 'lobby':
        if (!this.players.size) return { error: '還沒有玩家加入' };
        return this.nextQuestion();
      case 'intro':
        return this.openAnswers();
      case 'question':
        return this.endQuestion();
      case 'reveal':
        return this.qIndex >= this.questions.length - 1 ? this.toPodium() : this.toScoreboard();
      case 'scoreboard':
        return this.nextQuestion();
      case 'podium':
        return this.end();
      default:
        return { error: '遊戲已結束' };
    }
  }

  nextQuestion() {
    if (this.qIndex >= this.questions.length - 1) return this.toPodium();
    this.qIndex++;
    this.answers = new Map();
    this.reveal = null;
    for (const p of this.players.values()) p.lastResult = null;
    const introMs = this.settings.introSeconds * 1000;
    if (introMs <= 0) return this.openAnswers();
    this.phase = 'intro';
    this.phaseEndsAt = this.now() + introMs;
    this.later(introMs, () => this.openAnswers());
    this.pushAll();
    return { ok: true };
  }

  openAnswers() {
    const q = this.question;
    this.phase = 'question';
    this.startedAt = this.now();
    this.phaseEndsAt = this.startedAt + q.timeLimit * 1000;
    this.later(q.timeLimit * 1000 + ANSWER_GRACE_MS / 2, () => this.endQuestion());
    this.pushAll();
    return { ok: true };
  }

  validateChoice(q, choice) {
    if (q.type === 'text') {
      if (typeof choice !== 'string') return null;
      const s = [...choice.trim()].slice(0, 80).join('');
      return s ? s : null;
    }
    if (q.type === 'multi') {
      if (!Array.isArray(choice)) return null;
      const set = [...new Set(choice.map(Number))].filter((c) => Number.isInteger(c) && c >= 0 && c < q.options.length);
      return set.length ? set.sort() : null;
    }
    const c = Number(choice);
    return Number.isInteger(c) && c >= 0 && c < q.options.length ? c : null;
  }

  isCorrect(q, choice) {
    switch (q.type) {
      case 'quiz':
      case 'tf':
        return q.correct.includes(choice);
      case 'multi':
        return choice.length === q.correct.length && choice.every((c, i) => c === q.correct[i]);
      case 'text':
        return q.acceptedNorm.includes(normalizeAnswerText(choice));
      default:
        return false; // poll
    }
  }

  answer(playerId, qIndex, rawChoice) {
    const p = this.players.get(playerId);
    if (!p) return { error: '你已不在遊戲中' };
    if (this.phase !== 'question' || qIndex !== this.qIndex) return { error: '現在不能作答' };
    const now = this.now();
    if (now > this.phaseEndsAt + ANSWER_GRACE_MS) return { error: '時間到了' };
    if (this.answers.has(p.id)) return { error: '已經作答過了' };
    const q = this.question;
    const choice = this.validateChoice(q, rawChoice);
    if (choice === null) return { error: '答案格式錯誤' };
    const elapsed = Math.min(q.timeLimit * 1000, now - this.startedAt);
    this.answers.set(p.id, { choice, elapsed });
    this.touch();
    this.scheduleHostUpdate();
    this.maybeEndEarly();
    return { ok: true };
  }

  maybeEndEarly() {
    if (this.phase !== 'question' || !this.settings.autoEndWhenAllAnswered || !this.answers.size) return;
    for (const p of this.players.values()) {
      if (p.connected && !this.answers.has(p.id)) return;
    }
    // Short pause so the last player's "answer locked" feedback is visible before the reveal.
    this.later(400, () => this.endQuestion());
  }

  endQuestion() {
    if (this.phase !== 'question') return { error: '不在作答階段' };
    this.clearTimer();
    const q = this.question;
    const base = POINTS[q.points] || 0;
    const limitMs = q.timeLimit * 1000;
    const counts = q.options ? q.options.map(() => 0) : [];
    const textGroups = new Map();
    let correctPlayers = 0;

    for (const p of this.players.values()) {
      const a = this.answers.get(p.id);
      let correct = false;
      let points = 0;
      let bonus = 0;
      if (a) {
        if (q.type === 'multi') a.choice.forEach((c) => counts[c]++);
        else if (q.type === 'text') {
          const key = normalizeAnswerText(a.choice);
          const g = textGroups.get(key) || { text: a.choice, count: 0, correct: this.isCorrect(q, a.choice) };
          g.count++;
          textGroups.set(key, g);
        } else counts[a.choice]++;
        correct = this.isCorrect(q, a.choice);
      }
      if (q.type !== 'poll' && base > 0) {
        if (correct) {
          p.streak++;
          p.bestStreak = Math.max(p.bestStreak, p.streak);
          points = scoreFor(base, a.elapsed, limitMs);
          if (this.settings.streakBonus) bonus = streakBonusFor(p.streak);
        } else {
          p.streak = 0;
        }
      }
      if (correct) {
        correctPlayers++;
        p.correctCount++;
        p.correctTime += a.elapsed;
      }
      p.score += points + bonus;
      p.history[this.qIndex] = a
        ? { choice: a.choice, elapsed: a.elapsed, correct, points: points + bonus }
        : { choice: null, elapsed: null, correct: false, points: 0 };
      p.lastResult = { answered: !!a, correct, points, bonus, streak: p.streak };
    }

    this.rank(true);
    const ranking = this.ranking();
    for (let i = 0; i < ranking.length; i++) {
      const p = ranking[i];
      if (i > 0) p.lastResult.behind = { name: ranking[i - 1].name, gap: ranking[i - 1].score - p.score };
    }

    this.phase = 'reveal';
    this.reveal = {
      counts,
      textAnswers: [...textGroups.values()].sort((a, b) => b.count - a.count).slice(0, 10),
      answered: this.answers.size,
      correctPlayers,
      totalPlayers: this.players.size,
    };
    if (this.settings.autoAdvance) this.later(this.settings.autoAdvanceSeconds * 1000, () => this.next());
    this.pushAll();
    return { ok: true };
  }

  toScoreboard() {
    this.clearTimer();
    this.phase = 'scoreboard';
    if (this.settings.autoAdvance) this.later(this.settings.autoAdvanceSeconds * 1000, () => this.next());
    this.pushAll();
    return { ok: true };
  }

  toPodium() {
    this.clearTimer();
    this.phase = 'podium';
    this.rank();
    this.finalRanking = this.ranking();
    try {
      this.onFinish(this.results());
    } catch (e) {
      console.error('onFinish failed', e);
    }
    this.pushAll();
    return { ok: true };
  }

  end() {
    this.clearTimer();
    if (this.phase !== 'podium' && this.phase !== 'ended' && this.phase !== 'lobby') {
      this.rank();
      this.finalRanking = this.ranking();
    }
    this.phase = 'ended';
    this.pushAll();
    return { ok: true };
  }

  destroy() {
    this.clearTimer();
    if (this.hostFlushTimer) clearTimeout(this.hostFlushTimer);
    this.hostFlushTimer = null;
  }

  // ---------- ranking ----------

  ranking() {
    return [...this.players.values()].sort(
      (a, b) =>
        b.score - a.score ||
        b.correctCount - a.correctCount ||
        a.correctTime - b.correctTime ||
        a.joinedAt - b.joinedAt
    );
  }

  /** Recompute ranks. prevRank (for scoreboard movement arrows) only advances once per question. */
  rank(updatePrev = false) {
    this.ranking().forEach((p, i) => {
      if (updatePrev || !p.prevRank) p.prevRank = p.rank || i + 1;
      p.rank = i + 1;
    });
  }

  // ---------- views ----------

  publicQuestion(withAnswer) {
    const q = this.question;
    if (!q) return null;
    const out = {
      type: q.type,
      text: q.text,
      image: q.image || null,
      options: q.options || null,
      timeLimit: q.timeLimit,
      points: q.points,
    };
    if (withAnswer) {
      out.correct = q.correct || [];
      out.accepted = q.accepted || [];
    }
    return out;
  }

  remainingMs() {
    return this.phase === 'intro' || this.phase === 'question' ? Math.max(0, this.phaseEndsAt - this.now()) : 0;
  }

  hostView() {
    const v = {
      pin: this.pin,
      title: this.title,
      phase: this.phase,
      settings: this.settings,
      locked: this.locked,
      qIndex: this.qIndex,
      total: this.questions.length,
      playerCount: this.players.size,
      connectedCount: this.connectedCount(),
      remainingMs: this.remainingMs(),
      answeredCount: this.answers.size,
    };
    if (this.phase === 'lobby') {
      v.players = this.activePlayers().map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, connected: p.connected }));
    }
    if (this.phase === 'intro' || this.phase === 'question' || this.phase === 'reveal') {
      v.question = this.publicQuestion(this.phase === 'reveal');
    }
    if (this.phase === 'reveal') v.reveal = this.reveal;
    if (this.phase === 'scoreboard') {
      v.scoreboard = this.ranking()
        .slice(0, 5)
        .map((p) => ({
          id: p.id,
          name: p.name,
          avatar: p.avatar,
          score: p.score,
          rank: p.rank,
          prevRank: p.prevRank,
          gained: p.lastResult ? p.lastResult.points + p.lastResult.bonus : 0,
          streak: p.streak,
        }));
    }
    if (this.phase === 'podium' || this.phase === 'ended') {
      v.ranking = (this.finalRanking || this.ranking()).map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        score: p.score,
        rank: p.rank,
        correctCount: p.correctCount,
        bestStreak: p.bestStreak,
      }));
      v.stats = this.questionStats();
    }
    return v;
  }

  playerView(p) {
    const v = {
      pin: this.pin,
      title: this.title,
      phase: this.phase,
      qIndex: this.qIndex,
      total: this.questions.length,
      playerCount: this.players.size,
      me: { id: p.id, name: p.name, avatar: p.avatar, score: p.score, rank: p.rank, streak: p.streak },
      remainingMs: this.remainingMs(),
    };
    const q = this.question;
    if (q && (this.phase === 'intro' || this.phase === 'question')) {
      v.question = {
        type: q.type,
        timeLimit: q.timeLimit,
        points: q.points,
        optionCount: q.options ? q.options.length : 0,
        text: this.settings.showOnDevice ? q.text : null,
        options: this.settings.showOnDevice && q.options ? q.options : null,
      };
      const a = this.answers.get(p.id);
      v.answered = !!a;
    }
    if (this.phase === 'reveal' || this.phase === 'scoreboard') {
      v.result = p.lastResult;
      if (q && this.phase === 'reveal') {
        v.correctAnswer =
          q.type === 'text' ? q.accepted.join(' / ') : q.type === 'poll' ? null : q.correct.map((c) => q.options[c]).join('、');
        v.isPoll = q.type === 'poll';
      }
    }
    if (this.phase === 'podium' || this.phase === 'ended') {
      v.final = { rank: p.rank, score: p.score, correctCount: p.correctCount, bestStreak: p.bestStreak };
    }
    return v;
  }

  questionStats() {
    return this.questions.slice(0, this.qIndex + 1).map((q, i) => {
      let answered = 0;
      let correct = 0;
      for (const p of this.players.values()) {
        const h = p.history[i];
        if (h && h.choice !== null) answered++;
        if (h && h.correct) correct++;
      }
      return { text: q.text, type: q.type, answered, correct };
    });
  }

  results() {
    const ranking = this.finalRanking || this.ranking();
    return {
      pin: this.pin,
      title: this.title,
      finishedAt: new Date(this.now()).toISOString(),
      questions: this.questions.map((q) => ({ text: q.text, type: q.type, options: q.options, correct: q.correct, accepted: q.accepted })),
      players: ranking.map((p) => ({
        rank: p.rank,
        name: p.name,
        score: p.score,
        correctCount: p.correctCount,
        bestStreak: p.bestStreak,
        history: this.questions.map((_, i) => p.history[i] || null),
      })),
    };
  }

  // ---------- push ----------

  pushHost() {
    if (this.hostFlushTimer) {
      clearTimeout(this.hostFlushTimer);
      this.hostFlushTimer = null;
    }
    this.transport.toHost(this.pin, 'host:state', this.hostView());
  }

  /** Coalesce frequent host updates (joins / answers) to at most ~6 per second. */
  scheduleHostUpdate() {
    if (this.hostFlushTimer) return;
    this.hostFlushTimer = setTimeout(() => {
      this.hostFlushTimer = null;
      this.pushHost();
    }, 150);
  }

  pushPlayer(p) {
    if (p.connected) this.transport.toSocket(p.socketId, 'player:state', this.playerView(p));
  }

  pushAll() {
    this.pushHost();
    for (const p of this.players.values()) this.pushPlayer(p);
  }
}

module.exports = { Game, DEFAULT_SETTINGS, AVATARS, sanitizeSettings, scoreFor, streakBonusFor, cleanName, ANSWER_GRACE_MS };
