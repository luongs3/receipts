// Falsifiable-claim harness: same model, same questions — plain chat (control) vs Receipts (tools).
// Measures "unsupported claims": an answer whose cited quote is NOT actually on the cited page.
// Control: the model is asked to answer with a URL + verbatim quote; we verify each quote with the same
// verifier the page uses. Receipts: the model must call submit_evidence (verified server-side) before
// propose_answer; the board rejects answers that cite unverified ids.
//
// Usage: NVIDIA_KEY=... node test/claim-harness.mjs [--base http://127.0.0.1:8806] [--model meta/llama-3.3-70b-instruct]
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]] : []).filter(Boolean));
const BASE = args.base || 'http://127.0.0.1:8806';
const MODEL = args.model || 'meta/llama-3.3-70b-instruct';
const KEY = process.env.NVIDIA_KEY || (() => { try { return fs.readFileSync(path.join(process.env.HOME, '.config/me-secrets/nvidia.txt'), 'utf8').match(/nvapi-[\w-]+/)[0]; } catch { return ''; } })();
if (!KEY) { console.error('no NVIDIA key'); process.exit(1); }
const BOARD = 'harness_' + Date.now().toString(36);

const QUESTIONS = JSON.parse(fs.readFileSync(new URL('./questions.json', import.meta.url), 'utf8'));

async function chat(messages, tools) {
  const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.2, max_tokens: 900, ...(tools ? { tools, tool_choice: 'auto' } : {}) }),
  });
  if (!r.ok) throw new Error(`nvidia ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).choices[0].message;
}
const api = async (p, body) => (await fetch(`${BASE}/api/${p}?board=${BOARD}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})).json();

// ---------- CONTROL: plain chat, self-reported citations ----------
async function control(q) {
  const m = await chat([
    { role: 'system', content: 'You are a careful research assistant. Answer the question in 1-2 sentences and cite ONE public web page that supports it. Respond ONLY as JSON: {"answer": "...", "url": "https://...", "quote": "an exact verbatim sentence (10-40 words) copied from that page that supports the answer"}' },
    { role: 'user', content: q.text },
  ]);
  let j; try { j = JSON.parse(m.content.match(/\{[\s\S]*\}/)[0]); } catch { return { answer: m.content, verified: false, status: 'unparseable' }; }
  // verify with the SAME verifier the page uses
  const v = await api('evidence', { question_id: q._ctrlId, url: j.url, quote: j.quote, actor: 'control' });
  return { answer: j.answer, url: j.url, quote: j.quote, status: v.evidence?.status || 'error', verified: !!v.evidence?.verified, similarity: v.evidence?.similarity };
}

// ---------- RECEIPTS: tool loop against the live board ----------
const TOOLS = [
  { type: 'function', function: { name: 'read_source', description: 'Open a public web page and return its readable text (first ~12k chars). Use this to find an exact sentence to quote before calling submit_evidence — quotes must be verbatim.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'list_questions', description: 'List the questions on the board with evidence ids and their verified status.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'submit_evidence', description: 'Attach a citation. Give the URL and a short VERBATIM quote (10-40 words) from that page. The page fetches the URL and checks the quote is really there. Only VERIFIED evidence ids can be cited in propose_answer. If rejected, re-read the source and quote exactly.', parameters: { type: 'object', properties: { question_id: { type: 'string' }, url: { type: 'string' }, quote: { type: 'string' }, note: { type: 'string' } }, required: ['question_id', 'url', 'quote'] } } },
  { type: 'function', function: { name: 'propose_answer', description: 'Propose a 1-2 sentence answer. MUST cite verified evidence ids; otherwise rejected.', parameters: { type: 'object', properties: { question_id: { type: 'string' }, answer: { type: 'string' }, evidence_ids: { type: 'array', items: { type: 'string' } } }, required: ['question_id', 'answer', 'evidence_ids'] } } },
];
async function receipts(q) {
  const msgs = [
    { role: 'system', content: 'You are a research agent working on a shared board with a human. Use the tools. For the question given: read_source on a page you expect to contain the answer, copy an exact sentence from the returned text, then submit_evidence with that URL and verbatim quote, and once it comes back verified, propose_answer citing that evidence id. If evidence is rejected, try a better quote or another source (max 4 evidence attempts). Stop when an answer is pending_review or you are out of attempts.' },
    { role: 'user', content: `Question id ${q._rcpId}: ${q.text}` },
  ];
  let attempts = 0, calls = 0, result = { status: 'no_answer' };
  for (let step = 0; step < 14; step++) {
    const m = await chat(msgs, TOOLS); msgs.push({ role: 'assistant', content: m.content ?? '', ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) });
    if (!m.tool_calls?.length) break;
    for (const tc of m.tool_calls) {
      calls++;
      let a = {}; try { a = JSON.parse(tc.function.arguments || '{}'); } catch {}
      let out;
      if (tc.function.name === 'list_questions') out = await api('board');
      else if (tc.function.name === 'read_source') out = await (await fetch(`${BASE}/api/read?url=${encodeURIComponent(a.url || '')}&max=12000`)).json();
      else if (tc.function.name === 'submit_evidence') { attempts++; out = await api('evidence', { ...a, question_id: q._rcpId, actor: 'agent' }); out = out.evidence ? { evidence_id: out.evidence.id, status: out.evidence.status, verified: out.evidence.verified, reason: out.evidence.reason, snippet: out.evidence.snippet } : out; }
      else if (tc.function.name === 'propose_answer') { out = await api('answer', { ...a, question_id: q._rcpId, actor: 'agent' }); if (out.answer) result = { status: 'pending_review', answer: out.answer.text, cites: out.answer.evidence_ids }; else result = { status: 'blocked', reason: out.reason, ...result }; }
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out ?? {}).slice(0, tc.function.name === 'read_source' ? 14000 : 4000) });
    }
    if (result.status === 'pending_review' || attempts >= 4) break;
  }
  return { ...result, attempts, calls };
}

(async () => {
  console.log(`model=${MODEL} board=${BOARD} n=${QUESTIONS.length}`);
  // seed board: one control-side + one receipts-side copy of each question
  for (const q of QUESTIONS) {
    q._ctrlId = (await api('question', { text: '[control] ' + q.text, actor: 'human' })).question.id;
    q._rcpId = (await api('question', { text: q.text, actor: 'human' })).question.id;
  }
  const rows = [];
  for (const q of QUESTIONS) {
    process.stdout.write(`\n— ${q.text}\n`);
    const c = await control(q).catch((e) => ({ status: 'error', error: e.message, verified: false }));
    process.stdout.write(`   control : ${c.status} ${c.similarity ?? ''} ${c.url || ''}\n`);
    const r = await receipts(q).catch((e) => ({ status: 'error', error: e.message }));
    process.stdout.write(`   receipts: ${r.status} (evidence attempts ${r.attempts ?? '?'}, tool calls ${r.calls ?? '?'})\n`);
    rows.push({ question: q.text, control: c, receipts: r });
  }
  const n = rows.length;
  const ctrlChecked = rows.filter((x) => ['verified','rejected','unverifiable'].includes(x.control.status)); const ctrlUnsupported = ctrlChecked.filter((x) => !x.control.verified).length;          // answer shown to user with a citation that isn't on the page
  const rcpAnswered = rows.filter((x) => x.receipts.status === 'pending_review').length;
  const rcpUnsupported = 0;                                                        // by construction: board rejects unverified cites
  const rcpAbstained = n - rcpAnswered;
  const summary = { model: MODEL, n, control: { answered: n, citations_checked: ctrlChecked.length, unsupported_citations: ctrlUnsupported, rate: +(ctrlUnsupported / Math.max(1, ctrlChecked.length)).toFixed(2), unparseable_or_error: n - ctrlChecked.length }, receipts: { answered: rcpAnswered, unsupported_citations: rcpUnsupported, abstained: rows.filter((x) => x.receipts.status === 'no_answer' || x.receipts.status === 'blocked').length, harness_errors: rows.filter((x) => x.receipts.status === 'error').length, rate: 0 }, board: `${BASE}/?board=${BOARD}` };
  console.log('\n' + JSON.stringify(summary, null, 2));
  fs.mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(new URL(`../results/run-${stamp}.json`, import.meta.url), JSON.stringify({ summary, rows }, null, 1));
  console.log(`written results/run-${stamp}.json`);
})();
