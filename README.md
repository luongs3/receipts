# 🧾 Receipts — an evidence-gated research board for humans and their agents

**Live:** https://deploytest.theodoikenh.com/receipts/ · **Demo video:** _(link in the Devpost submission)_ · License: MIT

Receipts is a shared research board. A human pins questions. Their agent — ChatGPT's in-app browser, or Chrome with WebMCP enabled — answers them **through the page's tools**, and the page refuses to accept any answer that isn't backed by a citation **the page itself has verified**.

That inversion is the whole idea. In the usual WebMCP demo the page hands the agent a steering wheel (`book_slot`, `add_to_cart`). Here the page is the **referee**: `submit_evidence` fetches the cited URL server-side and checks the quoted passage really appears there; `propose_answer` is rejected unless every evidence id it cites came back `verified`. The human sees every move in a live activity log and is the only party who can accept an answer, pin a question, or dismiss a suggestion.

## What people and agents do together

| Human (UI) | Agent (WebMCP tools) | Shared state |
|---|---|---|
| Pins questions | `list_questions` reads them, with the human's comments | the board |
| Watches evidence arrive ✅ / ❌ / ⚠️ | `submit_evidence(url, quote)` → verified server-side | evidence cards with the page snippet |
| Accepts / rejects answers, leaves a follow-up comment | `propose_answer` (blocked without verified evidence); `get_board_state` sees the verdicts | answer cards + activity log |
| Pins or dismisses agent suggestions | `suggest_question` (appears as *suggested*, never auto-pinned) | question list |
| Adjudicates | `flag_conflict(evidence_a, evidence_b)` when sources disagree | conflict badge |

Neither side can do this alone: the agent can't fake a citation, and the human can't read forty sources. The output is an answer with receipts.

## Measured claim

`test/claim-harness.mjs` runs the **same model** on the **same 20 factual questions** two ways:

- **Control (plain chat):** "answer + cite a URL + verbatim quote" — the self-reported citation is then checked with the exact verifier the board uses.
- **Receipts (tools):** the model must get a citation `verified` by the page before `propose_answer` is accepted.

**Result (`openai/gpt-oss-120b`, 20 questions, `results/run-2026-09-02T12-33-11-968Z.json`):**

| | answered | citations that survive verification | unsupported citations | abstained |
|---|---|---|---|---|
| Plain chat (control) | 20 / 20 | **0 / 19** | **19 / 19 = 100 %** (10 quote-not-on-page, 9 dead or unreadable URL) | 0 |
| Through Receipts | 9 / 20 | **9 / 9** | **0** | 11 |

Same model, same questions. In plain chat it answered everything and every single citation it offered — including *"PostgreSQL's default port is 5432"* — was a quote that is not on the page it named. Through Receipts it answered fewer questions, but every shipped answer carries a quote the page verified, and the misses are abstentions the human can see, not confident fabrications. Both transcripts are in the results file.

## WebMCP implementation

`public/app.js` registers six tools on `navigator.modelContext ?? document.modelContext` (Chrome ships it on `document.modelContext`; the challenge brief shows `navigator`), each with a JSON-Schema `inputSchema`, `annotations.readOnlyHint` where appropriate, and an `execute()` that calls the board API and re-renders. Every `execute()` result is a JSON string an agent can act on (`{evidence_id, status, reason, snippet}`), and every mutation lands in the activity log tagged 🤖 so the human sees the agent working in real time.

The verifier (`server.js`) fetches the URL with a 12 s timeout, strips HTML, normalises whitespace/quotes, and scores the quote against the page with exact containment first, then an ordered-token (LCS) window match. Threshold 0.8. Private hosts are blocked. Fabricated and paraphrased quotes score 30–60 %; verbatim quotes with punctuation drift score 100 %.

No WebMCP in your browser? The page shows a banner and a **▶ Simulate agent** button that drives a scripted agent through the very same `execute()` functions — the board behaves identically.

## Run it

```bash
node server.js            # http://127.0.0.1:8806  (Node ≥ 20, zero dependencies)
NVIDIA_KEY=… node test/claim-harness.mjs --base http://127.0.0.1:8806   # control vs receipts
```

Test in Chrome: `chrome://flags/#enable-webmcp-testing` → Enabled → relaunch → open the URL, then in DevTools `await document.modelContext.getTools()`; or open the URL in ChatGPT's in-app browser and ask it to answer the pinned questions.

## Layout

```
server.js          board store (JSON per board id) + /api/* + citation verifier
public/app.js      UI + WebMCP tool registration + scripted-agent fallback
test/              claim harness + question set
results/           committed harness runs
```
