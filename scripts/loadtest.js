#!/usr/bin/env node
'use strict';
/*
 * End-to-end load test: one host + N bot players play a full game over real sockets.
 *   node scripts/loadtest.js [--url http://localhost:3000] [--players 100] [--password xxx] [--all-answer 1]
 * Verifies every player sees every phase, scores/ranks are consistent, and reports broadcast latency.
 */
const { io } = require('socket.io-client');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? acc.concat([[a.slice(2), arr[i + 1]]]) : acc), [])
);
const URL = args.url || 'http://localhost:3000';
const N = parseInt(args.players || '100', 10);
const PASSWORD = args.password || process.env.HOST_PASSWORD || '';
const ALL_ANSWER = 'all-answer' in args; // every bot answers -> questions end early

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ack = (s, ev, data) => new Promise((res) => s.timeout(10000).emit(ev, data, (err, r) => res(err ? { error: 'timeout' } : r)));
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};

async function main() {
  const quizzes = await (await fetch(URL + '/api/quizzes', { headers: { 'x-host-password': PASSWORD } })).json();
  if (!Array.isArray(quizzes) || !quizzes.length) throw new Error('No quizzes on server: ' + JSON.stringify(quizzes));
  const quizId = quizzes[0].id;

  const host = io(URL, { transports: ['websocket'], forceNew: true });
  await new Promise((r) => host.on('connect', r));
  const created = await ack(host, 'host:create', { quizId, password: PASSWORD, settings: { introSeconds: 1 } });
  if (created.error) throw new Error(created.error);
  const pin = created.pin;
  console.log(`game ${pin}: quiz "${quizzes[0].title}", connecting ${N} players…`);

  const errors = [];
  const latencies = [];
  let phaseSentAt = 0;
  let expectPhase = null;
  const bots = [];

  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      await sleep(Math.random() * 1500); // spread joins like real people
      const s = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
      const bot = { i, s, states: [], answeredQ: new Set(), final: null };
      bots.push(bot);
      await new Promise((r, j) => {
        s.on('connect', r);
        s.on('connect_error', j);
      });
      s.on('player:state', (st) => {
        bot.states.push(st.phase);
        if (expectPhase && st.phase === expectPhase && phaseSentAt) latencies.push(Date.now() - phaseSentAt);
        if (st.phase === 'question' && !st.answered && !bot.answeredQ.has(st.qIndex)) {
          bot.answeredQ.add(st.qIndex);
          const q = st.question;
          let choice;
          if (q.type === 'text') choice = Math.random() < 0.5 ? '木星' : '土星';
          else if (q.type === 'multi') choice = [...new Set([0, 1, 2, 3].filter(() => Math.random() < 0.5))].filter((c) => c < q.optionCount);
          else choice = Math.floor(Math.random() * q.optionCount);
          if (Array.isArray(choice) && !choice.length) choice = [0];
          // 5% of bots never answer (to exercise the timer path partly)
          if (!ALL_ANSWER && bot.i % 20 === 7) return;
          setTimeout(async () => {
            const r = await ack(s, 'player:answer', { qIndex: st.qIndex, choice });
            if (r.error) errors.push(`bot${i} q${st.qIndex}: ${r.error}`);
          }, 200 + Math.random() * 2500);
        }
        if (st.final) bot.final = st.final;
      });
      const r = await ack(s, 'player:join', { pin, name: `Bot${String(i).padStart(3, '0')}` });
      if (r.error) errors.push(`join bot${i}: ${r.error}`);
    })
  );
  console.log(`${N} players joined in ${Date.now() - t0} ms`);

  // Drive the game from the host side.
  let hostState = null;
  const phaseLog = [];
  host.on('host:state', (st) => {
    hostState = st;
  });
  await sleep(500);
  if (hostState.playerCount !== N) errors.push(`host sees ${hostState.playerCount} players, expected ${N}`);

  const advance = async (expect) => {
    expectPhase = expect;
    phaseSentAt = Date.now();
    const r = await ack(host, 'host:next', {});
    if (r.error) errors.push('host:next ' + r.error);
  };
  const waitPhase = async (phases, timeout = 60000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (hostState && phases.includes(hostState.phase)) return hostState.phase;
      await sleep(20);
    }
    throw new Error('timeout waiting for ' + phases + ' (at ' + (hostState && hostState.phase) + ')');
  };

  await advance('intro');
  const gameStart = Date.now();
  for (;;) {
    const ph = await waitPhase(['reveal']);
    phaseLog.push(`Q${hostState.qIndex + 1}: ${hostState.reveal.answered}/${N} answered, ${hostState.reveal.correctPlayers} correct`);
    await sleep(200);
    const last = hostState.qIndex >= hostState.total - 1;
    await advance(last ? 'podium' : 'scoreboard');
    if (last) break;
    await waitPhase(['scoreboard']);
    await sleep(200);
    await advance('intro');
    await waitPhase(['intro', 'question']);
  }
  await waitPhase(['podium']);
  await sleep(800);
  const gameMs = Date.now() - gameStart;

  // ---- verification ----
  const ranking = hostState.ranking;
  if (ranking.length !== N) errors.push(`ranking has ${ranking.length} players`);
  const ranks = ranking.map((r) => r.rank);
  if (ranks.some((r, i) => r !== i + 1)) errors.push('ranks are not 1..N in order');
  for (let i = 1; i < ranking.length; i++) if (ranking[i - 1].score < ranking[i].score) errors.push('ranking not sorted by score at ' + i);
  const finals = bots.filter((b) => b.final);
  if (finals.length !== N) errors.push(`${N - finals.length} bots did not receive final results`);
  for (const b of finals) {
    const r = ranking.find((x) => x.name === `Bot${String(b.i).padStart(3, '0')}`);
    if (!r || r.rank !== b.final.rank || r.score !== b.final.score) errors.push(`bot${b.i} final mismatch`);
  }
  const total = hostState.total;
  for (const b of bots) {
    const q = b.states.filter((p) => p === 'reveal').length;
    if (q !== total) errors.push(`bot${b.i} saw ${q} reveals, expected ${total}`);
  }

  phaseLog.forEach((l) => console.log('  ' + l));
  console.log(`top 3: ${ranking.slice(0, 3).map((r) => `${r.name}(${r.score})`).join(', ')}`);
  console.log(`game played in ${(gameMs / 1000).toFixed(1)} s`);
  console.log(`broadcast latency host:next -> player state: p50 ${pct(latencies, 50)} ms, p95 ${pct(latencies, 95)} ms, max ${Math.max(...latencies)} ms (${latencies.length} samples)`);

  const csv = await fetch(`${URL}/api/games/${pin}/results.csv?token=${created.hostToken}`);
  const text = await csv.text();
  const lines = text.trim().split(/\r?\n/).length;
  if (lines !== N + 1) errors.push(`CSV has ${lines} lines, expected ${N + 1}`);

  await ack(host, 'host:end', {});
  bots.forEach((b) => b.s.close());
  host.close();

  if (errors.length) {
    console.log(`\nFAILED with ${errors.length} errors:`);
    [...new Set(errors)].slice(0, 30).forEach((e) => console.log('  - ' + e));
    process.exit(1);
  }
  console.log('\nPASS ✓');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
