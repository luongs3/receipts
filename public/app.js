// Receipts — client. Renders the board, registers WebMCP tools, keeps human + agent on the same live state.
const BOARD = new URLSearchParams(location.search).get('board') || 'demo';
const api = async (p, body) => {
  const r = await fetch(`api/${p}?board=${encodeURIComponent(BOARD)}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return r.json();
};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let board = null; let flashIds = new Set();

// ---------------- rendering ----------------
function render() {
  const b = board; if (!b) return;
  $('#stats').innerHTML = `
    <span>questions <b>${b.questions.length}</b></span>
    <span>evidence ✅ <b>${b.stats.verified || 0}</b> ❌ <b>${b.stats.rejected || 0}</b> ⚠️ <b>${b.stats.unverifiable || 0}</b></span>
    <span>answers proposed <b>${b.stats.answersProposed || 0}</b> · blocked <b>${b.stats.answersRejected || 0}</b> · accepted <b>${b.stats.accepted || 0}</b></span>`;
  const qs = $('#questions');
  if (!b.questions.length) { qs.innerHTML = '<div class="empty">No questions yet. Pin one above — then ask your agent to answer it with receipts.</div>'; }
  else qs.innerHTML = b.questions.map(renderQ).join('');
  $('#activity').innerHTML = b.activity.slice(0, 60).map((a) => `<div class="act ${a.actor}"><span class="t">${new Date(a.ts).toLocaleTimeString()}</span> <span class="who">${a.actor === 'agent' ? '🤖 agent' : '✋ human'}</span> <span class="tool">${esc(a.tool)}</span> <span class="t">${esc(short(a.detail))}</span></div>`).join('') || '<div class="muted">nothing yet</div>';
  for (const id of flashIds) { const el = document.getElementById(id); if (el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 4000); } }
  flashIds.clear();
}
function short(d) { if (!d) return ''; const o = { ...d }; delete o.text; return Object.entries(o).map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 60 ? v.slice(0, 57) + '…' : JSON.stringify(v)}`).join(' '); }
function renderQ(q) {
  const ev = q.evidence.map((e) => `<div class="ev ${e.status}" id="${e.id}">
      <div class="badge">${e.status === 'verified' ? '✅ VERIFIED' : e.status === 'rejected' ? '❌ NOT ON PAGE' : '⚠️ UNVERIFIABLE'}</div>
      <div style="flex:1"><div class="quote">“${esc(e.quote)}”</div>
        <div class="meta"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.url)}</a> · ${esc(e.reason)}${e.similarity != null ? ` · overlap ${Math.round(e.similarity * 100)}%` : ''} · <span class="chip">${e.id}</span></div>
        ${e.snippet ? `<div class="snippet">page: …${esc(e.snippet.slice(0, 220))}…</div>` : ''}${e.note ? `<div class="snippet">note: ${esc(e.note)}</div>` : ''}</div></div>`).join('');
  const an = q.answers.map((a) => `<div class="an ${a.status}" id="${a.id}">
      <div><span class="chip">🤖 answer</span> ${esc(a.text)}</div>
      <div class="cites">cites: ${a.evidence_ids.join(', ')} · ${a.status.replace('_', ' ')}${a.comment ? ` · “${esc(a.comment)}”` : ''}</div>
      ${a.status === 'pending_review' ? `<div class="row"><button class="small ok" data-act="accept" data-q="${q.id}" data-a="${a.id}">Accept</button><button class="small bad" data-act="reject" data-q="${q.id}" data-a="${a.id}">Reject</button><input class="cmt" placeholder="optional comment / follow-up for the agent" data-for="${a.id}" style="flex:1"></div>` : ''}</div>`).join('');
  const cf = (q.conflicts || []).map((c) => `<div class="ev unverifiable"><div class="badge">⚔️ CONFLICT</div><div>${esc(c.evidence_a)} vs ${esc(c.evidence_b)} — ${esc(c.why)}</div></div>`).join('');
  const cm = q.comments?.length ? `<ul class="comments">${q.comments.map((c) => `<li>✋ ${esc(c.text)}</li>`).join('')}</ul>` : '';
  const actions = q.status === 'suggested' ? `<div class="qactions"><button class="small" data-act="promote" data-q="${q.id}">Pin it</button><button class="small bad" data-act="dismiss" data-q="${q.id}">Dismiss</button></div>` : `<div class="qactions"><button class="small ghost" data-act="dismiss" data-q="${q.id}">Remove</button></div>`;
  return `<div class="q" id="${q.id}"><h4><span class="status ${q.status}">${q.status}</span> ${esc(q.text)} <span class="id">${q.id}</span> ${q.pinnedBy === 'agent' ? '<span class="chip">🤖 suggested</span>' : '<span class="chip human">✋ pinned</span>'}</h4>${ev || '<div class="muted">no evidence yet</div>'}${cf}${an}${cm}${actions}</div>`;
}
async function refresh(flash = []) { board = await api('board'); flash.forEach((id) => flashIds.add(id)); render(); }

// ---------------- human actions ----------------
$('#pin').addEventListener('submit', async (e) => { e.preventDefault(); const t = $('#pin-text').value.trim(); if (!t) return; $('#pin-text').value = ''; await api('question', { text: t, actor: 'human' }); refresh(); });
$('#questions').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const comment = b.dataset.a ? (document.querySelector(`.cmt[data-for="${b.dataset.a}"]`)?.value || '') : '';
  await api('review', { question_id: b.dataset.q, answer_id: b.dataset.a, decision: b.dataset.act, comment }); refresh();
});
$('#btn-reset').addEventListener('click', async () => { if (confirm('Reset the demo board?')) { await api('reset', {}); refresh(); } });

// ---------------- WebMCP tools ----------------
const S = (props, required) => ({ type: 'object', properties: props, required });
const compact = (b) => ({
  board: b.id, title: b.title,
  questions: b.questions.map((q) => ({ id: q.id, text: q.text, status: q.status, pinned_by: q.pinnedBy,
    human_comments: q.comments?.map((c) => c.text) || [],
    evidence: q.evidence.map((e) => ({ id: e.id, status: e.status, url: e.url, similarity: e.similarity })),
    answers: q.answers.map((a) => ({ id: a.id, status: a.status, cites: a.evidence_ids, human_comment: a.comment || null })) })),
  stats: b.stats,
});

export const TOOLS = [
  { name: 'list_questions', title: 'List open questions',
    description: 'List the questions the human has pinned on this research board, with their status, existing evidence ids (and whether each was verified), proposed answers, and any human comments. Call this FIRST, and again after the human reviews your answers.',
    inputSchema: S({ status: { type: 'string', enum: ['open', 'answered', 'resolved', 'suggested', 'all'], description: 'Filter by status. Default: all.' } }, []),
    annotations: { readOnlyHint: true },
    execute: async ({ status } = {}) => { await refresh(); const c = compact(board); if (status && status !== 'all') c.questions = c.questions.filter((q) => q.status === status); return JSON.stringify(c); } },
  { name: 'submit_evidence', title: 'Submit a citation for verification',
    description: 'Attach a piece of evidence to a question. Give the exact URL and a short VERBATIM quote (10-40 words) from that page. The page will fetch the URL itself and check the quote really appears there; you get back {status: verified|rejected|unverifiable, evidence_id, similarity}. Only VERIFIED evidence ids can be cited in propose_answer. If rejected, re-read the source and quote it exactly.',
    inputSchema: S({ question_id: { type: 'string', description: 'Question id from list_questions, e.g. q1' }, url: { type: 'string', description: 'Public http(s) URL of the source' }, quote: { type: 'string', description: 'Exact quote copied from the page' }, note: { type: 'string', description: 'Optional: why this supports the answer' } }, ['question_id', 'url', 'quote']),
    execute: async (i) => { const r = await api('evidence', { ...i, actor: 'agent' }); await refresh([i.question_id, r.evidence?.id].filter(Boolean)); return JSON.stringify(r.error ? r : { evidence_id: r.evidence.id, status: r.evidence.status, verified: r.evidence.verified, reason: r.evidence.reason, similarity: r.evidence.similarity, snippet: r.evidence.snippet }); } },
  { name: 'propose_answer', title: 'Propose an answer (must cite verified evidence)',
    description: 'Propose an answer to a question. It MUST cite one or more evidence ids that this page has VERIFIED for that question; otherwise it is rejected and not shown. Accepted proposals appear on the board as "pending review" for the human to accept or reject. Keep the answer to 1-3 sentences.',
    inputSchema: S({ question_id: { type: 'string' }, answer: { type: 'string' }, evidence_ids: { type: 'array', items: { type: 'string' }, description: 'Verified evidence ids for this question' } }, ['question_id', 'answer', 'evidence_ids']),
    execute: async (i) => { const r = await api('answer', { ...i, actor: 'agent' }); await refresh([i.question_id, r.answer?.id].filter(Boolean)); return JSON.stringify(r); } },
  { name: 'flag_conflict', title: 'Flag conflicting sources',
    description: 'When two verified pieces of evidence for the same question disagree, flag the conflict so the human can adjudicate. Do not pick a side silently.',
    inputSchema: S({ question_id: { type: 'string' }, evidence_a: { type: 'string' }, evidence_b: { type: 'string' }, why: { type: 'string' } }, ['question_id', 'evidence_a', 'evidence_b', 'why']),
    execute: async (i) => { const r = await api('conflict', { ...i, actor: 'agent' }); await refresh([i.question_id]); return JSON.stringify(r); } },
  { name: 'suggest_question', title: 'Suggest a follow-up question',
    description: 'Suggest a follow-up question the human might want answered. It appears as "suggested" until the human pins or dismisses it — you cannot pin questions yourself.',
    inputSchema: S({ text: { type: 'string' } }, ['text']),
    execute: async (i) => { const r = await api('question', { text: i.text, actor: 'agent' }); await refresh([r.question?.id]); return JSON.stringify(r); } },
  { name: 'get_board_state', title: 'Full board state',
    description: 'Return the full board including the activity log (what the human did since your last call: accepts, rejects, comments, new pins).',
    inputSchema: S({}, []), annotations: { readOnlyHint: true },
    execute: async () => { await refresh(); return JSON.stringify({ ...compact(board), activity: board.activity.slice(0, 40) }); } },
];

async function registerTools() {
  const ctx = navigator.modelContext || document.modelContext;
  $('#toollist').innerHTML = TOOLS.map((t) => `<li><code>${t.name}</code> — ${esc(t.description.split('.')[0])}.</li>`).join('');
  if (!ctx?.registerTool) {
    $('#banner').classList.remove('hidden');
    $('#banner').innerHTML = `This browser doesn't expose <b>WebMCP</b>, so an agent can't call the page's tools here. Open the page in <b>ChatGPT's in-app browser</b>, or Chrome with <code>chrome://flags/#enable-webmcp-testing</code> enabled — or press <b>▶ Simulate agent</b> to watch a scripted agent use the exact same tools.`;
    return false;
  }
  if (window.__receiptsRegistered) return true; window.__receiptsRegistered = true;
  for (const t of TOOLS) {
    try { await ctx.registerTool({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations || { readOnlyHint: false }, execute: (input, opts) => t.execute(input, opts) }); }
    catch (e) { console.warn('registerTool failed', t.name, e); }
  }
  console.log('[receipts] registered', TOOLS.length, 'WebMCP tools');
  return true;
}

// ---------------- scripted agent (fallback demo; drives the same execute() functions) ----------------
const by = (n) => TOOLS.find((t) => t.name === n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function simulate() {
  const btn = $('#btn-sim'); btn.disabled = true; btn.textContent = '🤖 agent working…';
  try {
    await by('list_questions').execute({});
    await sleep(900);
    const q = board.questions.find((x) => x.status === 'open') || board.questions[0];
    if (!q) return;
    // 1) an honest-looking but fabricated quote → the page rejects it
    await by('submit_evidence').execute({ question_id: q.id, url: 'https://nodejs.org/en/blog/announcements/v22-release-announce', quote: 'Node.js 22 removes the WebSocket client entirely in favour of a third-party package', note: 'from memory' });
    await sleep(1200);
    // 2) a try at answering with the unverified id → blocked
    const bad = board.questions.find((x) => x.id === q.id).evidence.at(-1);
    await by('propose_answer').execute({ question_id: q.id, answer: 'No — the WebSocket client was removed in Node 22.', evidence_ids: [bad.id] });
    await sleep(1200);
    // 3) a real quote → verified → answer goes to human review
    await by('submit_evidence').execute({ question_id: q.id, url: 'https://nodejs.org/en/blog/announcements/v22-release-announce', quote: 'This provides a WebSocket client to Node.js without external dependencies', note: 'release announcement' });
    await sleep(1200);
    const good = board.questions.find((x) => x.id === q.id).evidence.filter((e) => e.verified).at(-1);
    if (good) await by('propose_answer').execute({ question_id: q.id, answer: 'Yes. Node.js 22 ships a built-in WebSocket client, enabled by default (per the v22 release announcement).', evidence_ids: [good.id] });
    await sleep(800);
    await by('suggest_question').execute({ text: 'Is the Node 22 WebSocket client spec-compliant with the WHATWG WebSocket API?' });
  } finally { btn.disabled = false; btn.textContent = '▶ Simulate agent'; }
}
$('#btn-sim').addEventListener('click', simulate);

// ---------------- boot ----------------
await refresh();
await registerTools();
setInterval(() => refresh(), 4000);   // keep the human's view live while an agent works from another surface
window.receipts = { TOOLS, refresh, simulate };
