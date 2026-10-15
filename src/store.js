'use strict';
// File-based quiz & results storage (one JSON file per quiz). Writes are atomic (tmp + rename).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dir, samplesDir) {
    this.quizDir = path.join(dir, 'quizzes');
    this.resultDir = path.join(dir, 'results');
    fs.mkdirSync(this.quizDir, { recursive: true });
    fs.mkdirSync(this.resultDir, { recursive: true });
    if (samplesDir && !this.listQuizzes().length) this.seed(samplesDir);
  }

  seed(samplesDir) {
    if (!fs.existsSync(samplesDir)) return;
    for (const f of fs.readdirSync(samplesDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const quiz = JSON.parse(fs.readFileSync(path.join(samplesDir, f), 'utf8'));
        this.saveQuiz(null, quiz);
      } catch (e) {
        console.warn('Skipping bad sample', f, e.message);
      }
    }
  }

  file(id) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) return null;
    return path.join(this.quizDir, id + '.json');
  }

  listQuizzes() {
    const out = [];
    for (const f of fs.readdirSync(this.quizDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const q = JSON.parse(fs.readFileSync(path.join(this.quizDir, f), 'utf8'));
        out.push({
          id: q.id,
          title: q.title,
          description: q.description || '',
          questionCount: (q.questions || []).length,
          updatedAt: q.updatedAt || null,
        });
      } catch (e) {
        console.warn('Unreadable quiz file', f, e.message);
      }
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  getQuiz(id) {
    const f = this.file(id);
    if (!f || !fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }

  saveQuiz(id, quiz, updatedAt = null) {
    id = id || crypto.randomBytes(5).toString('hex');
    const f = this.file(id);
    if (!f) throw new Error('bad id');
    const doc = { ...quiz, id, updatedAt: updatedAt || new Date().toISOString() };
    const tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, f);
    return doc;
  }

  deleteQuiz(id) {
    const f = this.file(id);
    if (!f || !fs.existsSync(f)) return false;
    fs.unlinkSync(f);
    this.addTombstone(id);
    return true;
  }

  // Tombstones (data/deleted.json, committed with the quizzes) stop browser-side backups from
  // resurrecting a quiz that was deleted on purpose.
  tombstoneFile() {
    return path.join(path.dirname(this.quizDir), 'deleted.json');
  }

  tombstones() {
    try {
      return new Set(JSON.parse(fs.readFileSync(this.tombstoneFile(), 'utf8')));
    } catch {
      return new Set();
    }
  }

  addTombstone(id) {
    const t = this.tombstones();
    t.add(id);
    fs.writeFileSync(this.tombstoneFile(), JSON.stringify([...t].sort(), null, 2) + '\n');
  }

  isDeleted(id) {
    return this.tombstones().has(id);
  }

  saveResults(results) {
    const stamp = results.finishedAt.replace(/[:.]/g, '-');
    const f = path.join(this.resultDir, `${stamp}_${results.pin}.json`);
    fs.writeFile(f, JSON.stringify(results, null, 2), (err) => {
      if (err) console.warn('Could not save results:', err.message);
    });
  }
}

module.exports = { Store };
