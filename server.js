// Receipts — evidence-gated research board. Node 22, zero deps.
// Serves /public and a tiny JSON API: boards + evidence verification.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8806);
const HOST = process.env.HOST || '127.0.0.1';
const DATA = path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
fs.mkdirSync(DATA, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

// ---------- board store (one JSON file per board) ----------
const seed = () => ({
  id: 'demo',
  title: 'Vendor due diligence — Q4 tooling',
  questions: [
    { id: 'q1', text: 'Does Node.js 22 ship with a built-in WebSocket client?', status: 'open', pinnedBy: 'human', evidence: [], answers: [], comments: [] },
    { id: 'q2', text: 'What is the Chrome flag that enables WebMCP for local testing?', status: 'open', pinnedBy: 'human', evidence: [], answers: [], comments: [] },
    { id: 'q3', text: 'Is the MIT license OSI-approved?', status: 'open', pinnedBy: 'human', evidence: [], answers: [], comments: [] },
  ],
  activity: [],
  stats: { verified: 0, rejected: 0, unverifiable: 0, answersProposed: 0, answersRejected: 0, accepted: 0 },
  createdAt: Date.now(),
});
const boardPath = (id) => path.join(DATA, `${id.replace(/[^a-z0-9_-]/gi, '')}.json`);
function loadBoard(id) {
  const p = boardPath(id);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  const b = seed(); b.id = id; saveBoard(b); return b;
}
function saveBoard(b) { fs.writeFileSync(boardPath(b.id), JSON.stringify(b, null, 1)); }
function log(b, actor, tool, detail) {
  b.activity.unshift({ ts: Date.now(), actor, tool, detail });
  b.activity = b.activity.slice(0, 200);
}
const uid = (p) => p + '_' + crypto.randomBytes(3).toString('hex');

// ---------- evidence verification ----------
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(?:39|x27);/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ').trim();
}
const norm = (s) => s.toLowerCase().replace(/[“”"'‘’`]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Fuzzy containment: slide a window the size of the quote across the page and score
// ORDERED token agreement (LCS ratio). Paraphrases and fabrications score low; verbatim
// quotes with minor punctuation/whitespace drift score high.
function lcsLen(a, b) {
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) { const tmp = dp[j]; dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]); prev = tmp; }
  }
  return dp[b.length];
}
function bestMatch(pageText, quote) {
  const q = norm(quote); const t = norm(pageText);
  if (!q) return { similarity: 0, snippet: '' };
  if (t.includes(q)) {
    const i = t.indexOf(q);
    return { similarity: 1, snippet: t.slice(Math.max(0, i - 80), i + q.length + 80) };
  }
  const qTok = q.split(' ');
  const tTok = t.split(' ');
  const win = qTok.length + 2;
  const qSet = new Set(qTok);
  // coarse pass: candidate windows by bag overlap, then exact LCS on the top few
  const cands = [];
  for (let i = 0; i + qTok.length <= tTok.length; i += Math.max(1, Math.floor(qTok.length / 3))) {
    let hit = 0; for (let j = 0; j < win && i + j < tTok.length; j++) if (qSet.has(tTok[i + j])) hit++;
    if (hit / qTok.length >= 0.4) cands.push([hit, i]);
  }
  cands.sort((a, b) => b[0] - a[0]);
  let best = 0, bestAt = 0;
  for (const [, i] of cands.slice(0, 40)) {
    const s = lcsLen(qTok, tTok.slice(i, i + win)) / qTok.length;
    if (s > best) { best = s; bestAt = i; }
  }
  const snippet = tTok.slice(Math.max(0, bestAt - 12), bestAt + win + 12).join(' ');
  return { similarity: Math.round(best * 100) / 100, snippet };
}

const THRESHOLD = 0.8;
async function verify(url, quote) {
  let u;
  try { u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { return { verified: false, status: 'unverifiable', reason: 'invalid URL', similarity: 0 }; }
  // block private ranges
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[::1\])/.test(u.hostname)) return { verified: false, status: 'unverifiable', reason: 'private host blocked', similarity: 0 };
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(u, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; ReceiptsVerifier/1.0; +https://receipts.theodoikenh.com)', 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' } });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) return { verified: false, status: 'unverifiable', reason: `HTTP ${r.status}`, similarity: 0, httpStatus: r.status };
    const raw = (await r.text()).slice(0, 3_000_000);
    const text = /html|xml/.test(ct) ? stripHtml(raw) : raw.replace(/\s+/g, ' ');
    if (text.length < 40) return { verified: false, status: 'unverifiable', reason: 'page has no readable text (JS-rendered or empty)', similarity: 0, httpStatus: r.status };
    const m = bestMatch(text, quote);
    const verified = m.similarity >= THRESHOLD;
    return { verified, status: verified ? 'verified' : 'rejected', reason: verified ? 'quote found on page' : `quote not found (best overlap ${Math.round(m.similarity * 100)}%)`, similarity: m.similarity, snippet: m.snippet, httpStatus: r.status, finalUrl: r.url, pageChars: text.length };
  } catch (e) {
    return { verified: false, status: 'unverifiable', reason: e.name === 'AbortError' ? 'fetch timeout (12s)' : `fetch failed: ${e.message}`, similarity: 0 };
  } finally { clearTimeout(t); }
}

// ---------- API ----------
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
async function body(req) { let s = ''; for await (const c of req) { s += c; if (s.length > 1e6) throw new Error('body too large'); } return s ? JSON.parse(s) : {}; }

const withBoard = (fn) => async (req, res, q) => { const id = q.get('board') || 'demo'; const b = loadBoard(id); const out = await fn(b, req, res, q); saveBoard(b); return out; };

const routes = {
  'GET /api/board': withBoard(async (b) => b),
  'POST /api/question': withBoard(async (b, req) => {
    const { text, actor = 'human' } = await body(req);
    if (!text?.trim()) return { error: 'text required' };
    const qn = { id: uid('q'), text: text.trim(), status: actor === 'agent' ? 'suggested' : 'open', pinnedBy: actor, evidence: [], answers: [], comments: [] };
    b.questions.push(qn); log(b, actor, actor === 'agent' ? 'add_question' : 'pin_question', { question_id: qn.id, text: qn.text });
    return { question: qn };
  }),
  'POST /api/evidence': withBoard(async (b, req) => {
    const { question_id, url, quote, note = '', actor = 'agent' } = await body(req);
    const qn = b.questions.find((x) => x.id === question_id);
    if (!qn) return { error: `unknown question_id ${question_id}` };
    if (!url || !quote) return { error: 'url and quote required' };
    const v = await verify(url, quote);
    const ev = { id: uid('ev'), url, quote, note, ...v, at: Date.now(), by: actor };
    qn.evidence.push(ev); b.stats[v.status] = (b.stats[v.status] || 0) + 1;
    log(b, actor, 'submit_evidence', { question_id, evidence_id: ev.id, url, status: v.status, similarity: v.similarity });
    return { evidence: ev };
  }),
  'POST /api/answer': withBoard(async (b, req) => {
    const { question_id, answer, evidence_ids = [], actor = 'agent' } = await body(req);
    const qn = b.questions.find((x) => x.id === question_id);
    if (!qn) return { error: `unknown question_id ${question_id}` };
    if (!answer?.trim()) return { error: 'answer required' };
    b.stats.answersProposed++;
    const ids = Array.isArray(evidence_ids) ? evidence_ids : [];
    const bad = ids.filter((id) => !qn.evidence.find((e) => e.id === id && e.verified));
    if (!ids.length || bad.length) {
      b.stats.answersRejected++;
      const reason = !ids.length ? 'an answer must cite at least one VERIFIED evidence id (call submit_evidence first)' : `evidence not verified for this question: ${bad.join(', ')}`;
      log(b, actor, 'propose_answer', { question_id, rejected: true, reason });
      return { rejected: true, reason, verified_evidence_ids: qn.evidence.filter((e) => e.verified).map((e) => e.id) };
    }
    const an = { id: uid('an'), text: answer.trim(), evidence_ids: ids, status: 'pending_review', by: actor, at: Date.now() };
    qn.answers.push(an); qn.status = 'answered';
    log(b, actor, 'propose_answer', { question_id, answer_id: an.id, evidence_ids: ids });
    return { answer: an, status: 'pending_review — a human must accept it on the board' };
  }),
  'POST /api/conflict': withBoard(async (b, req) => {
    const { question_id, evidence_a, evidence_b, why, actor = 'agent' } = await body(req);
    const qn = b.questions.find((x) => x.id === question_id);
    if (!qn) return { error: `unknown question_id ${question_id}` };
    const c = { id: uid('cf'), evidence_a, evidence_b, why, at: Date.now() };
    (qn.conflicts ||= []).push(c); log(b, actor, 'flag_conflict', { question_id, ...c });
    return { conflict: c };
  }),
  'POST /api/review': withBoard(async (b, req) => {   // human-only decisions
    const { question_id, answer_id, decision, comment = '' } = await body(req);
    const qn = b.questions.find((x) => x.id === question_id);
    if (!qn) return { error: 'unknown question' };
    if (answer_id) {
      const an = qn.answers.find((a) => a.id === answer_id); if (!an) return { error: 'unknown answer' };
      an.status = decision === 'accept' ? 'accepted' : 'rejected'; an.reviewedAt = Date.now(); an.comment = comment;
      if (decision === 'accept') { qn.status = 'resolved'; b.stats.accepted++; } else qn.status = 'open';
      log(b, 'human', decision === 'accept' ? 'accept_answer' : 'reject_answer', { question_id, answer_id, comment });
    } else if (decision === 'promote') { qn.status = 'open'; qn.pinnedBy = 'human'; log(b, 'human', 'pin_question', { question_id, promoted: true }); }
    else if (decision === 'dismiss') { b.questions = b.questions.filter((x) => x.id !== question_id); log(b, 'human', 'dismiss_question', { question_id }); }
    if (comment && decision !== 'accept') { qn.comments?.push({ text: comment, at: Date.now() }); }
    return { ok: true, question: qn };
  }),
  'POST /api/reset': withBoard(async (b) => { const f = seed(); f.id = b.id; Object.assign(b, f); log(b, 'human', 'reset_board', {}); return { ok: true }; }),
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const key = `${req.method} ${u.pathname}`;
  if (routes[key]) {
    try { json(res, 200, await routes[key](req, res, u.searchParams)); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  // static
  let f = u.pathname === '/' ? '/index.html' : u.pathname;
  f = path.normalize(path.join(PUBLIC, f));
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, HOST, () => console.log(`receipts listening on http://${HOST}:${PORT}`));
