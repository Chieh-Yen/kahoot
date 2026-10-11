'use strict';
// Quiz schema normalization / validation. Shared by the REST API and the game engine.

const TYPES = ['quiz', 'multi', 'tf', 'text', 'poll'];
const POINTS = { standard: 1000, double: 2000, none: 0 };
const LIMITS = {
  title: 120,
  description: 500,
  questions: 200,
  text: 300,
  option: 250,
  accepted: 10,
  acceptedLen: 80,
  image: 3 * 1024 * 1024,
  minTime: 5,
  maxTime: 240,
};

function str(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeAnswerText(s) {
  return str(s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

function normalizeQuestion(raw, i, errors) {
  const where = `第 ${i + 1} 題`;
  const q = {};
  q.type = TYPES.includes(raw && raw.type) ? raw.type : 'quiz';
  q.text = str(raw && raw.text).slice(0, LIMITS.text);
  if (!q.text) errors.push(`${where}：題目不可空白`);

  let t = parseInt(raw && raw.timeLimit, 10);
  if (!Number.isFinite(t)) t = 20;
  q.timeLimit = Math.min(LIMITS.maxTime, Math.max(LIMITS.minTime, t));

  q.points = Object.prototype.hasOwnProperty.call(POINTS, raw && raw.points) ? raw.points : 'standard';
  if (q.type === 'poll') q.points = 'none';

  const img = str(raw && raw.image);
  if (img) {
    if (!/^(https?:\/\/|data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,)/i.test(img)) {
      errors.push(`${where}：圖片必須是 http(s) 網址或上傳的圖片`);
    } else if (img.length > LIMITS.image) {
      errors.push(`${where}：圖片太大（上限約 2MB）`);
    } else q.image = img;
  }

  if (q.type === 'text') {
    const acc = (Array.isArray(raw.accepted) ? raw.accepted : [])
      .map((a) => str(a).slice(0, LIMITS.acceptedLen))
      .filter(Boolean)
      .slice(0, LIMITS.accepted);
    if (!acc.length) errors.push(`${where}：填空題至少需要一個正確答案`);
    q.accepted = acc;
    return q;
  }

  let options = Array.isArray(raw && raw.options) ? raw.options.map((o) => str(o).slice(0, LIMITS.option)) : [];
  if (q.type === 'tf') {
    options = [options[0] || '正確', options[1] || '錯誤'];
  } else {
    // Drop trailing empty options, keep order (correct indices refer to it).
    while (options.length && !options[options.length - 1]) options.pop();
    if (options.length < 2 || options.length > 4) errors.push(`${where}：選項需要 2～4 個`);
    if (options.some((o) => !o)) errors.push(`${where}：選項不可空白`);
    options = options.slice(0, 4);
  }
  q.options = options;

  if (q.type === 'poll') {
    q.correct = [];
    return q;
  }
  const correct = [...new Set((Array.isArray(raw.correct) ? raw.correct : [raw.correct])
    .map((c) => parseInt(c, 10))
    .filter((c) => Number.isInteger(c) && c >= 0 && c < options.length))].sort();
  if (!correct.length) errors.push(`${where}：請標記至少一個正確答案`);
  if (q.type === 'tf' && correct.length > 1) errors.push(`${where}：是非題只能有一個正確答案`);
  q.correct = correct;
  return q;
}

/** Returns { quiz, errors }. quiz is always a usable normalized object. */
function normalizeQuiz(raw) {
  const errors = [];
  raw = raw && typeof raw === 'object' ? raw : {};
  const quiz = {
    title: str(raw.title).slice(0, LIMITS.title),
    description: str(raw.description).slice(0, LIMITS.description),
    questions: [],
  };
  if (!quiz.title) errors.push('測驗名稱不可空白');
  const qs = Array.isArray(raw.questions) ? raw.questions : [];
  if (!qs.length) errors.push('至少需要一題');
  if (qs.length > LIMITS.questions) errors.push(`最多 ${LIMITS.questions} 題`);
  quiz.questions = qs.slice(0, LIMITS.questions).map((q, i) => normalizeQuestion(q || {}, i, errors));
  return { quiz, errors };
}

module.exports = { normalizeQuiz, normalizeAnswerText, TYPES, POINTS, LIMITS };
