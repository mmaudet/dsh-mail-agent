// Does giving the model the thread close the gap between a draft and a reply?
//
//   node scripts/measure-draft-thread.mjs --limit 8 --accept-third-party
//
// The first draft measurement found the style right and the substance empty:
// eight drafts, all of them "thank you, I will look at this", where the owner
// answered. The obvious explanation is that the prompt carries one message and
// a reply is answering a conversation.
//
// Obvious explanations have been wrong twice in this project — recipient
// position, then thread state for the classifier — so this compares the same
// eight pairs with and without the thread rather than assuming.
//
// PERIMETER: sends the owner's sent mail and whole threads to the model.

import {
  JmapAdapter,
  learnStyle,
  renderDraftRequest,
  DRAFT_SYSTEM_PROMPT,
  cleanDraft,
  ownWords,
} from '../packages/dsh-mail-core/dist/index.js';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const LIMIT = Number(arg('limit', '8'));
const MODEL = arg('model', 'mistralai/mistral-small-3.2-24b-instruct');
const BASE = 'https://openrouter.ai/api/v1';
if (!args.includes('--accept-third-party')) {
  console.error('Refusing: this sends sent mail and whole threads to a third party.');
  process.exit(2);
}
const KEY = process.env.OPENROUTER_API_KEY;

const ACC = process.env.MAIL_SENTINEL_JMAP_ACCOUNT_ID;
const bearer = JSON.parse(process.env.MAIL_SENTINEL_JMAP_TOKENS).accessToken;
let apiUrl = null;
// Checks the status before parsing. Without it a proxy answering
// "Client Closed Request" in plain text surfaces as a JSON syntax error, which
// sends the reader looking at the wrong layer.
async function jmap(using, methodCalls) {
  if (!apiUrl) {
    const s = await fetch(process.env.MAIL_SENTINEL_JMAP_SESSION_URL, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!s.ok) throw new Error(`JMAP session ${s.status}: ${(await s.text()).slice(0, 80)}`);
    apiUrl = (await s.json()).apiUrl;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ using, methodCalls }),
    });
    if (r.ok) return r.json();
    // A closed request is the server pacing a burst, not a bad question.
    if (r.status < 500 && r.status !== 499 && r.status !== 429) {
      throw new Error(`JMAP ${r.status}: ${(await r.text()).slice(0, 80)}`);
    }
    await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
  }
  throw new Error('JMAP kept refusing');
}
const adapter = new JmapAdapter({ transport: { request: (b) => jmap(b.using, b.methodCalls) }, accountId: ACC, identityId: 'x' });

const style = learnStyle(await adapter.getMessages(await adapter.messagesSince('Sent', new Date('2026-08-01'), 200)), { examples: 3 });
if (style === null) { console.error('too few replies'); process.exit(2); }

const sent = (await adapter.getMessages(await adapter.messagesSince('Sent', new Date('2026-08-24'), 200)))
  .filter((m) => m.inReplyTo.length > 0);
const inbox = await adapter.getMessages(await adapter.messagesSince('INBOX', new Date('2026-08-17'), 900));
const byMessageId = new Map(inbox.map((m) => [m.messageId, m]));

const pairs = [];
for (const reply of sent) {
  const original = reply.inReplyTo.map((id) => byMessageId.get(id)).find(Boolean);
  const theirs = original === undefined ? '' : ownWords(reply);
  if (original === undefined || theirs.length === 0) continue;
  pairs.push({ original, theirs, reply });
  if (pairs.length >= LIMIT) break;
}

/** Everything in the thread that arrived before this message. */
async function threadBefore(message) {
  if (message.threadId === null) return [];
  const t = await jmap([['Thread/get', { accountId: ACC, ids: [message.threadId] }, 't']]);
  const emailIds = t.methodResponses[0][1].list?.[0]?.emailIds ?? [];
  const members = await adapter.getMessages(emailIds.filter((id) => id !== message.id));
  return members
    .filter((m) => m.receivedAt < message.receivedAt)
    .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
}

async function ask(system, user) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL, temperature: 0.3, max_tokens: 800,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    if (r.ok) return (await r.json()).choices?.[0]?.message?.content ?? '';
    if (r.status !== 429 && r.status < 500) throw new Error(String(r.status));
    await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
  }
  throw new Error('gave up');
}

const words = (t) => t.split(/\s+/).filter(Boolean).length;
// The shape the first measurement found in every draft: a promise to deal with
// it rather than a dealing with it.
const ACKNOWLEDGEMENT = /(je vais|nous allons|je reviens vers|i will (get back|review|look)|je (l'|les )?examine|je vous (tiens|recontacte)|dès que possible)/i;

const rows = [];
for (const { original, theirs } of pairs) {
  const prior = await threadBefore(original);
  const base = renderDraftRequest({ message: original, category: 'correspondance-commerciale-client', style, owner: '' });
  const withThread = prior.length === 0 ? base : [
    base,
    '',
    `--- ${String(prior.length)} earlier messages in this thread, oldest first ---`,
    ...prior.map((m) => `From: ${m.from[0]?.email ?? '?'}\n${(m.bodyText ?? m.preview).slice(0, 1200)}`),
  ].join('\n');

  const [without, with_] = [await ask(DRAFT_SYSTEM_PROMPT, base), await ask(DRAFT_SYSTEM_PROMPT, withThread)];
  const a = cleanDraft(without);
  const b = cleanDraft(with_);
  rows.push({ theirs, without: a, with: b, prior: prior.length, subject: original.subject });

  console.log('-'.repeat(70));
  console.log(`${original.subject.slice(0, 60)}   (${prior.length} earlier in thread)`);
  console.log(`\n  THEY WROTE (${words(theirs)})`);
  console.log(theirs.split('\n').map((l) => '    ' + l).join('\n').slice(0, 400));
  console.log(`\n  WITHOUT THREAD (${words(a)})`);
  console.log(a.split('\n').map((l) => '    ' + l).join('\n').slice(0, 400));
  console.log(`\n  WITH THREAD (${words(b)})`);
  console.log(b.split('\n').map((l) => '    ' + l).join('\n').slice(0, 400));
  console.log('');
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
const ack = (set) => set.filter((r) => ACKNOWLEDGEMENT.test(r)).length;
console.log('='.repeat(70));
console.log(`\n  pairs                       ${rows.length}`);
console.log(`  had a thread to show        ${rows.filter((r) => r.prior > 0).length}`);
console.log(`\n  median words, theirs        ${median(rows.map((r) => words(r.theirs)))}`);
console.log(`  median words, no thread     ${median(rows.map((r) => words(r.without)))}`);
console.log(`  median words, with thread   ${median(rows.map((r) => words(r.with)))}`);
console.log(`\n  "I'll get back to you", no thread   ${ack(rows.map((r) => r.without))}/${rows.length}`);
console.log(`  "I'll get back to you", with thread ${ack(rows.map((r) => r.with))}/${rows.length}`);
console.log(`  and in what they actually wrote     ${ack(rows.map((r) => r.theirs))}/${rows.length}`);
