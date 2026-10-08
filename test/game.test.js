'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, scoreFor, streakBonusFor, cleanName } = require('../src/game');
const { normalizeQuiz } = require('../src/quiz');

function fakeTransport() {
  const sent = [];
  return {
    sent,
    toHost: (pin, ev, data) => sent.push({ to: 'host', ev, data }),
    toSocket: (id, ev, data) => sent.push({ to: id, ev, data }),
    last(to, ev) {
      for (let i = sent.length - 1; i >= 0; i--) if (sent[i].to === to && sent[i].ev === ev) return sent[i].data;
      return null;
    },
  };
}

const QUIZ = normalizeQuiz({
  title: 'T',
  questions: [
    { type: 'quiz', text: 'q1', timeLimit: 10, options: ['a', 'b', 'c', 'd'], correct: [1] },
    { type: 'multi', text: 'q2', timeLimit: 10, options: ['a', 'b', 'c'], correct: [0, 2] },
    { type: 'text', text: 'q3', timeLimit: 10, accepted: ['Jupiter', '木星'] },
    { type: 'poll', text: 'q4', timeLimit: 10, options: ['x', 'y'] },
    { type: 'tf', text: 'q5', timeLimit: 10, points: 'double', correct: [0] },
  ],
});

function setup(settings = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const tr = fakeTransport();
  const g = new Game({ pin: '123456', quiz: QUIZ.quiz, settings: { introSeconds: 0, ...settings }, transport: tr, now: clock.now });
  return { g, tr, clock };
}

test('quiz normalization reports errors', () => {
  assert.deepEqual(QUIZ.errors, []);
  const bad = normalizeQuiz({ title: '', questions: [{ type: 'quiz', text: '', options: ['a'], correct: [5] }] });
  assert.ok(bad.errors.length >= 3, bad.errors.join());
});

test('score formula', () => {
  assert.equal(scoreFor(1000, 0, 10000), 1000);
  assert.equal(scoreFor(1000, 10000, 10000), 500);
  assert.equal(scoreFor(1000, 5000, 10000), 750);
  assert.equal(scoreFor(2000, 20000, 10000), 1000); // clamped
  assert.equal(scoreFor(0, 0, 10000), 0);
  assert.equal(streakBonusFor(1), 0);
  assert.equal(streakBonusFor(2), 100);
  assert.equal(streakBonusFor(9), 500);
});

test('name cleaning and uniqueness', () => {
  const { g } = setup();
  assert.equal(cleanName('  a​  b\n '), 'a b');
  assert.equal([...cleanName('一二三四五六七八九十一二三四五六七八')].length, 16);
  assert.ok(g.join('Amy', null, 's1').player);
  assert.match(g.join('amy', null, 's2').error, /已經有人使用/);
  assert.match(g.join('   ', null, 's3').error, /請輸入暱稱/);
});

test('full game flow with scoring, streaks, ranking, podium', () => {
  const { g, tr, clock } = setup();
  const a = g.join('A', null, 'sa').player;
  const b = g.join('B', null, 'sb').player;
  const c = g.join('C', null, 'sc').player;

  assert.deepEqual(g.next(), { ok: true });
  assert.equal(g.phase, 'question');
  // Correct answer must not leak to anyone during the question.
  assert.equal(tr.last('host', 'host:state').question.correct, undefined);
  assert.equal(JSON.stringify(tr.last('sa', 'player:state')).includes('correct'), false);

  // Q1: A answers correct instantly, B correct at 5s, C wrong.
  assert.deepEqual(g.answer(a.id, 0, 1), { ok: true });
  assert.match(g.answer(a.id, 0, 2).error, /已經作答/);
  clock.advance(5000);
  g.answer(b.id, 0, 1);
  g.answer(c.id, 0, 0);
  assert.equal(g.phase, 'question'); // early end is deferred by 400ms
  g.endQuestion();
  assert.equal(g.phase, 'reveal');
  assert.equal(a.score, 1000);
  assert.equal(b.score, 750);
  assert.equal(c.score, 0);
  assert.equal(a.rank, 1);
  assert.equal(c.lastResult.behind.name, 'B');
  assert.equal(c.lastResult.behind.gap, 750);
  assert.deepEqual(g.reveal.counts, [1, 2, 0, 0]);
  assert.deepEqual(tr.last('host', 'host:state').question.correct, [1]);

  // Q2 multi: A exact set (streak 2 => +100), B partial (wrong), C no answer.
  g.next(); // scoreboard
  assert.equal(g.phase, 'scoreboard');
  g.next(); // question 2
  assert.equal(g.qIndex, 1);
  g.answer(a.id, 1, [2, 0, 2]);
  g.answer(b.id, 1, [0]);
  clock.advance(10_000);
  g.next();
  assert.equal(a.score, 1000 + 1000 + 100);
  assert.equal(a.streak, 2);
  assert.equal(b.streak, 0);
  assert.equal(c.lastResult.answered, false);

  // Q3 text: normalized comparison.
  g.next();
  g.next();
  g.answer(a.id, 2, ' jupiter ');
  g.answer(b.id, 2, '木星');
  g.answer(c.id, 2, '土星');
  g.endQuestion();
  assert.equal(a.lastResult.correct, true);
  assert.equal(b.lastResult.correct, true);
  assert.equal(c.lastResult.correct, false);
  assert.equal(g.reveal.textAnswers.length, 3);

  // Q4 poll: no points, streak preserved.
  g.next();
  g.next();
  const streakBefore = a.streak;
  const scoreBefore = a.score;
  g.answer(a.id, 3, 0);
  g.endQuestion();
  assert.equal(a.score, scoreBefore);
  assert.equal(a.streak, streakBefore);

  // Q5 tf double points.
  g.next();
  g.next();
  g.answer(c.id, 4, 0);
  g.endQuestion();
  assert.equal(c.lastResult.points, 2000);

  // Last reveal -> podium directly.
  g.next();
  assert.equal(g.phase, 'podium');
  const hv = tr.last('host', 'host:state');
  assert.equal(hv.ranking.length, 3);
  assert.equal(hv.ranking[0].name, 'A');
  assert.deepEqual(hv.ranking.map((r) => r.rank), [1, 2, 3]);
  const pv = tr.last('sc', 'player:state');
  assert.ok(pv.final.rank >= 1);
  g.destroy();
});

test('answers rejected outside the window, timer auto-ends, late answers within grace accepted', async () => {
  const { g, clock } = setup({ autoEndWhenAllAnswered: false });
  const a = g.join('A', null, 'sa').player;
  const b = g.join('B', null, 'sb').player;
  assert.match(g.answer(a.id, 0, 1).error, /不能作答/);
  g.next();
  assert.match(g.answer(a.id, 1, 1).error, /不能作答/); // wrong qIndex
  assert.match(g.answer(a.id, 0, 9).error, /格式/);
  clock.advance(10_300); // after the deadline but within grace
  assert.deepEqual(g.answer(a.id, 0, 1), { ok: true });
  assert.equal(a.score, 0);
  clock.advance(1000);
  assert.match(g.answer(b.id, 0, 1).error, /時間到/);
  g.endQuestion();
  assert.equal(a.score, 500); // elapsed clamped to time limit
  g.destroy();
});

test('auto end when all connected players answered (disconnected ignored)', async () => {
  const { g } = setup();
  const a = g.join('A', null, 'sa').player;
  g.join('B', null, 'sb');
  g.next();
  g.disconnect('sb');
  g.answer(a.id, 0, 1);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(g.phase, 'reveal');
  g.destroy();
});

test('resume, kick, lock and late join', () => {
  const { g, tr } = setup({ allowLateJoin: false });
  const a = g.join('A', null, 'sa').player;
  const b = g.join('B', null, 'sb').player;
  g.disconnect('sa');
  assert.equal(a.connected, false);
  const r = g.resume(a.token, 'sa2');
  assert.equal(r.player, a);
  assert.equal(a.socketId, 'sa2');
  assert.match(g.resume('nope', 'x').error, /找不到/);

  g.kick(b.id);
  assert.ok(tr.sent.find((m) => m.to === 'sb' && m.ev === 'player:kicked'));
  assert.match(g.join('B', null, 'sb').error, /無法使用/);

  g.setLocked(true);
  assert.match(g.join('Z', null, 'sz').error, /鎖定/);
  g.setLocked(false);
  g.next();
  assert.match(g.join('Late', null, 'sl').error, /已經開始/);
  g.destroy();
});

test('late joiner gets a rank and can answer', () => {
  const { g } = setup();
  const a = g.join('A', null, 'sa').player;
  g.next();
  g.answer(a.id, 0, 1);
  const late = g.join('Late', null, 'sl').player;
  assert.equal(late.rank, 2);
  assert.deepEqual(g.answer(late.id, 0, 1), { ok: true });
  g.destroy();
});

test('shuffle options remaps correct answers', () => {
  for (let i = 0; i < 20; i++) {
    const { g } = setup({ shuffleOptions: true, shuffleQuestions: true });
    for (const q of g.questions) {
      const orig = QUIZ.quiz.questions.find((o) => o.text === q.text);
      if (q.correct && q.options) {
        assert.deepEqual(q.correct.map((c) => q.options[c]).sort(), orig.correct.map((c) => orig.options[c]).sort());
      }
    }
    g.destroy();
  }
});

test('100 players: rank ordering is total and consistent', () => {
  const { g, clock } = setup();
  const ps = [];
  for (let i = 0; i < 100; i++) ps.push(g.join('P' + i, null, 's' + i).player);
  g.next();
  ps.forEach((p, i) => {
    clock.advance(37);
    g.answer(p.id, 0, i % 3 === 0 ? 0 : 1);
  });
  g.endQuestion();
  const ranks = ps.map((p) => p.rank).sort((x, y) => x - y);
  assert.deepEqual(ranks, Array.from({ length: 100 }, (_, i) => i + 1));
  const r = g.ranking();
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].score >= r[i].score);
  g.destroy();
});
