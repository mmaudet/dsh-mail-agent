// Can a model enumerate the intentions a message admits, without choosing?
//
//   node scripts/measure-intent-candidates.mjs --limit 8 --accept-third-party
//
// The drafts measured empty because a reply needs an intention and the prompt
// carried none. The owner proposes finding the intention first, and asking them
// only when it cannot be found.
//
// The falsifiable half is narrower than "can it find the intention". A message
// asking "can you sign this?" admits a small, enumerable set — sign, refuse,
// ask something first — and which one the owner picks is not in the message.
// So this asks whether the *set* contains what they actually did, judged
// against the reply they actually sent.
//
// If it usually does, choosing is one tap and no typing. If it does not, the
// owner has to say what they mean, and a threshold would only be choosing when
// to guess.
//
// PERIMETER: sends received and sent mail to a third-party model.

import {
  JmapAdapter,
  learnStyle,
  ownWords,
} from '../packages/dsh-mail-core/dist/index.js';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const LIMIT = Number(arg('limit', '8'));
const MODEL = arg('model', 'mistralai/mistral-small-3.2-24b-instruct');
const JUDGE = arg('judge', 'anthropic/claude-sonnet-5');
const BASE = 'https://openrouter.ai/api/v1';
if (!args.includes('--accept-third-party')) {
  console.error('Refusing: this sends mail to a third party.');
  process.exit(2);
}
const KEY = process.env.OPENROUTER_API_KEY;

const ACC = process.env.MAIL_SENTINEL_JMAP_ACCOUNT_ID;
const bearer = JSON.parse(process.env.MAIL_SENTINEL_JMAP_TOKENS).accessToken;
let apiUrl = null;
async function jmap(methodCalls) {
  if (!apiUrl) {
    const s = await fetch(process.env.MAIL_SENTINEL_JMAP_SESSION_URL, { headers: { authorization: `Bearer ${bearer}` } });
    if (!s.ok) throw new Error(`session ${s.status}`);
    apiUrl = (await s.json()).apiUrl;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls }),
    });
    if (r.ok) return r.json();
    if (r.status < 500 && r.status !== 499 && r.status !== 429) throw new Error(`JMAP ${r.status}`);
    await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
  }
  throw new Error('JMAP kept refusing');
}
const adapter = new JmapAdapter({ transport: { request: (b) => jmap(b.methodCalls) }, accountId: ACC, identityId: 'x' });

async function ask(model, system, user, maxTokens = 900) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    if (r.ok) return (await r.json()).choices?.[0]?.message?.content ?? '';
    if (r.status !== 429 && r.status < 500) throw new Error(String(r.status));
    await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
  }
  throw new Error('gave up');
}

const CANDIDATES = [
  'You are shown one email somebody has received. List the replies its sender',
  'could reasonably be waiting for.',
  '',
  'Each is one short line saying what the owner would be deciding — not how it',
  'would be phrased. "Accept 14h". "Propose another time". "Confirm the',
  'documents are signed". "Say the budget is not approved yet".',
  '',
  'Rules:',
  '- At most 3, and fewer when fewer are plausible.',
  '- They must be genuinely different decisions, not rewordings of one.',
  '- Include the refusal or the negative when it is plausible. Somebody who',
  '  asks for something can be told no, and a list that only contains yes is a',
  '  list that has decided for the owner.',
  '- If the message asks for nothing at all, answer with an empty list.',
  '',
  'Answer as JSON and nothing else:',
  '{"intentions": ["...", "..."]}',
].join('\n');

const VERDICT = [
  'Below is an email somebody received, a list of intentions an assistant',
  'thought its sender might be waiting for, and the reply that was actually',
  'sent.',
  '',
  'Answer whether the list contains the decision the reply actually made.',
  '',
  '"covered" — one of the intentions is the decision the reply made, even if',
  'worded differently.',
  '"partial" — an intention is close but misses something the reply decided.',
  '"missed" — the reply made a decision no intention anticipated.',
  '"nothing-asked" — the reply decided nothing; it acknowledged or thanked.',
  '',
  'Answer as JSON: {"verdict": "...", "which": <index or null>, "why": "one short line"}',
].join('\n');

const sent = (await adapter.getMessages(await adapter.messagesSince('Sent', new Date('2026-08-24'), 200)))
  .filter((m) => m.inReplyTo.length > 0);
const inbox = await adapter.getMessages(await adapter.messagesSince('INBOX', new Date('2026-08-17'), 900));
const byMessageId = new Map(inbox.map((m) => [m.messageId, m]));

const pairs = [];
for (const reply of sent) {
  const original = reply.inReplyTo.map((id) => byMessageId.get(id)).find(Boolean);
  const theirs = original === undefined ? '' : ownWords(reply);
  if (original === undefined || theirs.length < 15) continue;
  pairs.push({ original, theirs });
  if (pairs.length >= LIMIT) break;
}

const parse = (text) => {
  const m = /\{[\s\S]*\}/.exec(text);
  return m === null ? null : JSON.parse(m[0]);
};

const rows = [];
for (const { original, theirs } of pairs) {
  const body = (original.bodyText ?? original.preview).slice(0, 3000);
  const listed = parse(await ask(MODEL, CANDIDATES,
    `From: ${original.from[0]?.email ?? '?'}\nSubject: ${original.subject}\n\n${body}`));
  const intentions = listed?.intentions ?? [];

  const judged = parse(await ask(JUDGE, VERDICT, [
    `RECEIVED:\nFrom: ${original.from[0]?.email ?? '?'}\nSubject: ${original.subject}\n\n${body}`,
    '',
    `INTENTIONS PROPOSED:\n${intentions.map((x, i) => `${String(i)}. ${x}`).join('\n') || '(none)'}`,
    '',
    `REPLY ACTUALLY SENT:\n${theirs}`,
  ].join('\n'), 400));

  rows.push({ subject: original.subject, intentions, verdict: judged?.verdict ?? 'error', why: judged?.why ?? '' });

  console.log('-'.repeat(70));
  console.log(original.subject.slice(0, 62));
  console.log(`  proposed: ${intentions.map((x) => `"${x}"`).join('  |  ') || '(none)'}`);
  console.log(`  reply   : ${theirs.replace(/\s+/g, ' ').slice(0, 130)}`);
  console.log(`  verdict : ${judged?.verdict ?? 'error'} — ${judged?.why ?? ''}`);
}

const count = (v) => rows.filter((r) => r.verdict === v).length;
console.log(`\n${'='.repeat(70)}\n`);
console.log(`  messages                              ${rows.length}`);
console.log(`  intentions listed, median             ${[...rows.map((r) => r.intentions.length)].sort()[Math.floor(rows.length / 2)]}`);
console.log(`\n  the list contained the real decision  ${count('covered')}/${rows.length}`);
console.log(`  it was close but incomplete           ${count('partial')}/${rows.length}`);
console.log(`  it missed entirely                    ${count('missed')}/${rows.length}`);
console.log(`  the reply decided nothing             ${count('nothing-asked')}/${rows.length}`);
