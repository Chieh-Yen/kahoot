(function () {
  'use strict';
  const { $, h, shape, storage, toast, TYPE_LABEL } = window.K;

  const app = $('#app');
  let password = storage.get('host-password', '');
  let list = [];
  let quiz = null; // working copy { id?, title, description, questions }
  let dirty = false;
  let errors = [];

  const TIMES = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
  const POINTS = { standard: '標準分數', double: '雙倍分數', none: '不計分' };

  const blankQuestion = (type = 'quiz') => normalizeType({ type, text: '', timeLimit: 20, points: 'standard', options: ['', '', '', ''], correct: [0], accepted: [] }, type);

  function normalizeType(q, type) {
    q.type = type;
    if (type === 'tf') {
      q.options = ['正確', '錯誤'];
      q.correct = [q.correct && q.correct[0] === 1 ? 1 : 0];
    } else if (type === 'text') {
      q.accepted = q.accepted && q.accepted.length ? q.accepted : [''];
    } else {
      const opts = (q.options || []).filter((o, i) => !(q.type === 'tf' && i > 1));
      while (opts.length < 4) opts.push('');
      q.options = opts.slice(0, 4);
      if (type === 'poll') q.correct = [];
      else if (!q.correct || !q.correct.length) q.correct = [0];
      if (type === 'quiz' && q.correct.length > 1) q.correct = [q.correct[0]];
    }
    if (type === 'poll') q.points = 'none';
    else if (q.points === 'none' && type !== 'poll') q.points = 'standard';
    return q;
  }

  /** Bring a stored quiz into editor shape (always 4 option slots, etc). */
  function toWorking(doc) {
    const q = JSON.parse(JSON.stringify(doc));
    q.questions = (q.questions || []).map((x) => {
      const y = { timeLimit: 20, points: 'standard', options: [], correct: [], accepted: [], ...x };
      if (y.type === 'tf') return y;
      if (y.type !== 'text') {
        while (y.options.length < 4) y.options.push('');
      }
      return y;
    });
    return q;
  }

  /** Strip editor-only padding before saving / exporting. */
  function toPayload() {
    return {
      title: quiz.title,
      description: quiz.description || '',
      questions: quiz.questions.map((q) => {
        const out = { type: q.type, text: q.text, timeLimit: q.timeLimit, points: q.points };
        if (q.image) out.image = q.image;
        if (q.type === 'text') out.accepted = q.accepted.map((a) => a.trim()).filter(Boolean);
        else {
          let opts = q.options.map((o) => o.trim());
          while (opts.length > 2 && !opts[opts.length - 1] && !(q.correct || []).includes(opts.length - 1)) opts.pop();
          out.options = opts;
          if (q.type !== 'poll') out.correct = q.correct.filter((c) => c < opts.length);
        }
        return out;
      }),
    };
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'x-host-password': password } });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      await login();
      return api(path, opts);
    }
    if (!res.ok) throw Object.assign(new Error(data.error || '發生錯誤'), { data });
    return data;
  }

  function login() {
    return new Promise((resolve) => {
      const input = h('input', { class: 'input', type: 'password', placeholder: '主持人密碼' });
      const ov = h('div', { class: 'login-overlay' },
        h('form', { class: 'card', style: { width: 'min(92vw,360px)', display: 'flex', flexDirection: 'column', gap: '12px' }, onsubmit: async (e) => {
          e.preventDefault();
          const r = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: input.value }) });
          if (!r.ok) return toast('密碼錯誤', 'error');
          password = input.value;
          storage.set('host-password', password);
          ov.remove();
          resolve();
        } }, h('b', null, '題目編輯器需要主持人密碼'), input, h('button', { class: 'btn primary block' }, '登入'))
      );
      document.body.append(ov);
      setTimeout(() => input.focus(), 30);
    });
  }

  function setDirty(v = true) {
    dirty = v;
    const d = $('.dirty');
    if (d) d.hidden = !dirty;
  }
  window.addEventListener('beforeunload', (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (quiz) save();
    }
  });

  // ---------------- load / save ----------------

  async function refreshList() {
    list = await api('/api/quizzes');
    const restored = await K.QuizBackup.restoreMissing(list, password);
    if (restored) {
      list = await api('/api/quizzes');
      toast(`已從這台電腦的備份還原 ${restored} 份測驗`, 'success', 4000);
    }
  }

  async function open(id) {
    if (dirty && !confirm('有未儲存的變更，確定要離開？')) return;
    try {
      const doc = await api('/api/quizzes/' + encodeURIComponent(id));
      K.QuizBackup.save(doc);
      quiz = toWorking(doc);
      errors = [];
      setDirty(false);
      history.replaceState(null, '', '#' + id);
      render();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function newQuiz(doc) {
    if (dirty && !confirm('有未儲存的變更，確定要離開？')) return;
    quiz = doc ? toWorking({ ...doc, id: undefined }) : { title: '', description: '', questions: [blankQuestion('quiz')] };
    delete quiz.id;
    errors = [];
    setDirty(!!doc);
    history.replaceState(null, '', '#');
    render();
    if (!doc) setTimeout(() => $('.ed-title')?.focus(), 30);
  }

  async function save() {
    try {
      const body = JSON.stringify(toPayload());
      const doc = quiz.id
        ? await api('/api/quizzes/' + quiz.id, { method: 'PUT', body })
        : await api('/api/quizzes', { method: 'POST', body });
      quiz.id = doc.id;
      K.QuizBackup.save(doc);
      errors = [];
      setDirty(false);
      history.replaceState(null, '', '#' + doc.id);
      await refreshList();
      render();
      toast('已儲存 ✓', 'success');
    } catch (e) {
      errors = (e.data && e.data.errors) || [e.message];
      render();
      toast('儲存失敗：' + errors[0], 'error', 4000);
    }
  }

  async function del() {
    if (!quiz.id) return newQuiz();
    if (!confirm(`確定要刪除「${quiz.title}」？此動作無法復原。`)) return;
    await api('/api/quizzes/' + quiz.id, { method: 'DELETE' });
    await K.QuizBackup.remove(quiz.id);
    setDirty(false);
    quiz = null;
    await refreshList();
    history.replaceState(null, '', '#');
    render();
    toast('已刪除');
  }

  function download(name, text, type = 'application/json') {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  function pickFile(accept) {
    return new Promise((resolve) => {
      const inp = h('input', { type: 'file', accept, style: { display: 'none' }, onchange: () => resolve(inp.files[0] || null) });
      document.body.append(inp);
      inp.click();
      setTimeout(() => inp.remove(), 60000);
    });
  }

  async function importJson() {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try {
      const doc = JSON.parse(await f.text());
      if (!doc || !Array.isArray(doc.questions)) throw new Error('不是有效的測驗 JSON');
      newQuiz(doc);
      toast('已匯入，請檢查後按「儲存」', 'success', 3500);
    } catch (e) {
      toast('匯入失敗：' + e.message, 'error');
    }
  }

  // ---------------- CSV ----------------

  const CSV_HEAD = ['題型', '題目', '選項1', '選項2', '選項3', '選項4', '正確答案', '秒數', '計分'];

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let q = false;
    text = text.replace(/^\ufeff/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim()));
  }

  const TYPE_ALIASES = { quiz: 'quiz', 單選: 'quiz', 單選題: 'quiz', multi: 'multi', 複選: 'multi', 複選題: 'multi', 多選: 'multi', tf: 'tf', 是非: 'tf', 是非題: 'tf', text: 'text', 填空: 'text', 填空題: 'text', 簡答: 'text', poll: 'poll', 投票: 'poll' };
  const POINT_ALIASES = { standard: 'standard', 標準: 'standard', double: 'double', 雙倍: 'double', none: 'none', 不計分: 'none', '0': 'none', '1': 'standard', '2': 'double' };

  function csvToQuestions(rows) {
    if (rows.length && /題型|type/i.test(rows[0][0])) rows = rows.slice(1);
    const out = [];
    const problems = [];
    rows.forEach((r, i) => {
      const [t, text, o1, o2, o3, o4, ans = '', sec, pts] = r.map((c) => (c || '').trim());
      const type = TYPE_ALIASES[(t || '').toLowerCase()] || TYPE_ALIASES[t] || 'quiz';
      const q = blankQuestion(type);
      q.text = text || '';
      q.timeLimit = TIMES.includes(+sec) ? +sec : Math.min(240, Math.max(5, +sec || 20));
      q.points = type === 'poll' ? 'none' : POINT_ALIASES[(pts || '').toLowerCase()] || 'standard';
      const parts = ans.split(/[|;、，,]/).map((s) => s.trim()).filter(Boolean);
      if (type === 'text') q.accepted = parts.length ? parts : [o1, o2, o3, o4].filter(Boolean);
      else if (type === 'tf') {
        const a = (parts[0] || '').toLowerCase();
        q.correct = [/^(2|x|f|false|錯|錯誤|否|×)$/.test(a) ? 1 : 0];
        if (o1) q.options[0] = o1;
        if (o2) q.options[1] = o2;
      } else {
        q.options = [o1, o2, o3, o4].map((o) => o || '');
        if (type !== 'poll') {
          q.correct = parts.map((p) => parseInt(p, 10) - 1).filter((n) => n >= 0 && n < 4);
          if (!q.correct.length) problems.push(`第 ${i + 1} 列沒有正確答案`);
        }
      }
      out.push(q);
    });
    return { out, problems };
  }

  async function importCsv() {
    const f = await pickFile('.csv,text/csv');
    if (!f) return;
    const { out, problems } = csvToQuestions(parseCsv(await f.text()));
    if (!out.length) return toast('CSV 裡沒有題目', 'error');
    if (!quiz) newQuiz();
    const onlyBlank = quiz.questions.length === 1 && !quiz.questions[0].text;
    quiz.questions = onlyBlank ? out : quiz.questions.concat(out);
    if (!quiz.title) quiz.title = f.name.replace(/\.csv$/i, '');
    setDirty();
    render();
    toast(`已匯入 ${out.length} 題` + (problems.length ? `（${problems.length} 個問題需要修正）` : ''), problems.length ? 'error' : 'success', 4000);
  }

  function csvTemplate() {
    const rows = [
      CSV_HEAD,
      ['單選', '台灣最高的山是？', '雪山', '玉山', '合歡山', '阿里山', '2', '20', '標準'],
      ['複選', '哪些是程式語言？', 'Python', 'HTML', 'Rust', 'Go', '1|3|4', '30', '標準'],
      ['是非', '地球是圓的', '', '', '', '', 'O', '15', '雙倍'],
      ['填空', '太陽系最大的行星？', '', '', '', '', '木星|Jupiter', '25', '標準'],
      ['投票', '最喜歡的季節？', '春', '夏', '秋', '冬', '', '15', ''],
    ];
    const esc = (c) => (/[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c);
    download('quiz-template.csv', '\ufeff' + rows.map((r) => r.map(esc).join(',')).join('\r\n'), 'text/csv');
  }

  // ---------------- images ----------------

  async function imageToDataUrl(file) {
    if (file.type === 'image/gif' && file.size < 1.5e6) return readAsDataUrl(file);
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = url;
      });
      const max = 1280;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = h('canvas', { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.82);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  function readAsDataUrl(file) {
    return new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(file);
    });
  }

  // ---------------- render ----------------

  function render() {
    const scroll = window.scrollY;
    setScreen(
      h('div', { class: 'ed-top' },
        h('a', { class: 'logo', href: '/host', style: { color: '#fff', textDecoration: 'none' } }, 'Quiz', h('span', null, 'Live')),
        h('b', null, '題目編輯器'),
        h('span', { class: 'dirty', hidden: !dirty }, '未儲存'),
        h('span', { class: 'spacer' }),
        quiz ? h('button', { class: 'btn ok sm', onclick: save, title: 'Ctrl/⌘ + S' }, '💾 儲存') : null,
        quiz && quiz.id ? h('a', { class: 'btn light sm', href: '/host?quiz=' + quiz.id, onclick: (e) => { if (dirty && !confirm('有未儲存的變更，仍要前往？')) e.preventDefault(); } }, '▶ 用這份開始遊戲') : null,
        h('a', { class: 'btn ghost sm', href: '/host' }, '主持人頁')
      ),
      h('div', { class: 'ed-layout' }, sidebar(), h('div', { class: 'ed-main' }, quiz ? editorBody() : welcome()))
    );
    window.scrollTo(0, scroll);
  }

  function setScreen(...n) {
    app.replaceChildren(...n);
  }

  function sidebar() {
    return h('div', { class: 'ed-side' },
      h('button', { class: 'btn accent block', onclick: () => newQuiz() }, '＋ 新測驗'),
      h('div', { class: 'row' },
        h('button', { class: 'btn light sm', style: { flex: 1 }, onclick: importJson }, '匯入 JSON'),
        h('button', { class: 'btn light sm', style: { flex: 1 }, onclick: importCsv }, '匯入 CSV')
      ),
      list.map((q) => h('div', { class: 'item' + (quiz && quiz.id === q.id ? ' active' : ''), onclick: () => open(q.id) }, h('b', null, q.title), h('span', null, `${q.questionCount} 題`)))
    );
  }

  function welcome() {
    return h('div', { class: 'card' },
      h('h2', { style: { marginTop: 0 } }, '建立你的測驗'),
      h('p', null, '從左邊選一份測驗編輯，或建立新的。'),
      h('ul', { class: 'hint' },
        h('li', null, '題型：單選、複選、是非、填空、投票（不計分）。'),
        h('li', null, '可以上傳圖片（會自動壓縮並存在測驗裡），或貼上圖片網址。'),
        h('li', null, '可用 CSV 從試算表批次匯入題目：', h('a', { href: '#', onclick: (e) => { e.preventDefault(); csvTemplate(); } }, '下載 CSV 範本'), '。'),
        h('li', null, '匯出 JSON 可備份或分享測驗（免費雲端主機重啟後檔案可能會消失，記得備份）。')
      )
    );
  }

  function editorBody() {
    const qErr = new Set();
    for (const e of errors) {
      const m = /^第 (\d+) 題/.exec(e);
      if (m) qErr.add(+m[1] - 1);
    }
    return [
      errors.length ? h('div', { class: 'errors' }, '請修正以下問題：', h('ul', null, errors.map((e) => h('li', null, e)))) : null,
      h('div', { class: 'card', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('input', { class: 'ed-input ed-title', placeholder: '測驗名稱', maxlength: 120, value: quiz.title, oninput: (e) => { quiz.title = e.target.value; setDirty(); } }),
        h('textarea', { class: 'ed-textarea', placeholder: '說明（選填）', maxlength: 500, rows: 2, value: quiz.description || '', oninput: (e) => { quiz.description = e.target.value; setDirty(); } }),
        h('div', { class: 'row wrap' },
          h('span', { class: 'hint' }, `${quiz.questions.length} 題 · 約 ${Math.ceil(quiz.questions.reduce((s, q) => s + q.timeLimit + 12, 0) / 60)} 分鐘`),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn light sm', onclick: () => download((quiz.title || 'quiz') + '.json', JSON.stringify(toPayload(), null, 2)) }, '⬇ 匯出 JSON'),
          h('button', { class: 'btn light sm', onclick: csvTemplate }, 'CSV 範本'),
          h('button', { class: 'btn light sm', onclick: () => newQuiz({ ...toPayload(), title: quiz.title + '（副本）' }) }, '⧉ 複製測驗'),
          h('button', { class: 'btn danger sm', onclick: del }, '🗑 刪除')
        )
      ),
      quiz.questions.map((q, i) => questionCard(q, i, qErr.has(i))),
      h('div', { class: 'card add-bar' }, h('b', null, '新增題目：'),
        Object.entries(TYPE_LABEL).map(([t, label]) => h('button', { class: 'btn light', onclick: () => {
          quiz.questions.push(blankQuestion(t));
          setDirty();
          render();
          const cards = document.querySelectorAll('.qcard');
          const last = cards[cards.length - 1];
          last?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          last?.querySelector('textarea')?.focus();
        } }, '＋ ' + label))
      ),
      h('div', { style: { height: '40px' } }),
    ];
  }

  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= quiz.questions.length) return;
    [quiz.questions[i], quiz.questions[j]] = [quiz.questions[j], quiz.questions[i]];
    setDirty();
    render();
  }

  function questionCard(q, i, hasError) {
    const upd = (fn, rerender) => (e) => {
      fn(e);
      setDirty();
      if (rerender) render();
    };
    const head = h('div', { class: 'qcard-head' },
      h('span', { class: 'qn' }, `Q${i + 1}`),
      h('select', { class: 'ed-select', onchange: upd((e) => normalizeType(q, e.target.value), true) },
        Object.entries(TYPE_LABEL).map(([t, l]) => h('option', { value: t, selected: q.type === t }, l))),
      h('select', { class: 'ed-select', title: '作答時間', onchange: upd((e) => (q.timeLimit = +e.target.value)) },
        [...new Set([...TIMES, q.timeLimit])].sort((a, b) => a - b).map((t) => h('option', { value: t, selected: q.timeLimit === t }, `⏱ ${t} 秒`))),
      q.type !== 'poll'
        ? h('select', { class: 'ed-select', title: '計分', onchange: upd((e) => (q.points = e.target.value)) },
          Object.entries(POINTS).map(([k, l]) => h('option', { value: k, selected: q.points === k }, l)))
        : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: '上移', onclick: () => move(i, -1) }, '↑'),
      h('button', { class: 'icon-btn', title: '下移', onclick: () => move(i, 1) }, '↓'),
      h('button', { class: 'icon-btn', title: '複製', onclick: () => { quiz.questions.splice(i + 1, 0, JSON.parse(JSON.stringify(q))); setDirty(); render(); } }, '⧉'),
      h('button', { class: 'icon-btn del', title: '刪除', onclick: () => {
        if (quiz.questions.length === 1) return toast('至少要有一題', 'error');
        if ((q.text || '').trim() && !confirm(`刪除 Q${i + 1}？`)) return;
        quiz.questions.splice(i, 1);
        setDirty();
        render();
      } }, '🗑')
    );

    const text = h('textarea', { class: 'ed-textarea', placeholder: '輸入題目…', maxlength: 300, rows: 2, value: q.text, oninput: (e) => { q.text = e.target.value; setDirty(); } });

    const imgUrl = h('input', { class: 'ed-input', placeholder: '圖片網址（選填）', value: q.image && !q.image.startsWith('data:') ? q.image : '', onchange: upd((e) => (q.image = e.target.value.trim() || undefined), true) });
    const img = h('div', { class: 'img-row' },
      imgUrl,
      h('button', { class: 'btn light sm', onclick: async () => {
        const f = await pickFile('image/*');
        if (!f) return;
        try {
          q.image = await imageToDataUrl(f);
          if (q.image.length > 2.8e6) {
            q.image = undefined;
            return toast('圖片太大', 'error');
          }
          setDirty();
          render();
        } catch {
          toast('無法讀取這張圖片', 'error');
        }
      } }, '🖼 上傳圖片'),
      q.image ? h('img', { class: 'img-preview', src: q.image, alt: '' }) : null,
      q.image ? h('button', { class: 'btn light sm', onclick: upd(() => (q.image = undefined), true) }, '移除圖片') : null
    );

    let body;
    if (q.type === 'text') {
      body = h('div', null,
        h('label', { class: 'field-label' }, '可接受的答案（每行一個，比對時不分大小寫、忽略前後空白）'),
        h('textarea', { class: 'ed-textarea', rows: 3, placeholder: '例如：\n木星\nJupiter', value: q.accepted.join('\n'), oninput: (e) => { q.accepted = e.target.value.split('\n'); setDirty(); } })
      );
    } else {
      const multiCorrect = q.type === 'multi';
      const rows = q.options.map((o, oi) => {
        const isC = (q.correct || []).includes(oi);
        return h('div', { class: 'opt-row' + (isC && q.type !== 'poll' ? ' is-correct' : '') },
          h('span', { class: `sw ans-${oi}` }, shape(oi)),
          h('input', { class: 'ed-input', placeholder: oi < 2 ? `選項 ${oi + 1}` : `選項 ${oi + 1}（選填）`, maxlength: 120, value: o, oninput: (e) => { q.options[oi] = e.target.value; setDirty(); } }),
          q.type === 'poll' ? null : h('label', { class: 'correct', title: '標記為正確答案' },
            h('input', { type: multiCorrect ? 'checkbox' : 'radio', name: 'c' + i, checked: isC, onchange: upd((e) => {
              if (multiCorrect) {
                const s = new Set(q.correct);
                e.target.checked ? s.add(oi) : s.delete(oi);
                q.correct = [...s].sort();
              } else q.correct = [oi];
            }, true) }), '正確')
        );
      });
      body = h('div', null,
        h('div', { class: 'opt-grid' }, rows),
        h('div', { class: 'hint', style: { marginTop: '6px' } },
          { quiz: '選一個正確答案。', multi: '可勾選多個正確答案，玩家必須全部選對才得分。', tf: '選擇正確或錯誤。', poll: '投票不計分，用來暖場或收集意見。' }[q.type])
      );
    }
    return h('div', { class: 'card qcard' + (hasError ? ' has-error' : '') }, head, text, img, body);
  }

  // ---------------- boot ----------------
  K.keepServerAwake();
  (async () => {
    try {
      await refreshList();
    } catch (e) {
      toast(e.message, 'error');
    }
    const id = location.hash.slice(1);
    if (id && list.some((q) => q.id === id)) await open(id);
    else render();
  })();
})();
