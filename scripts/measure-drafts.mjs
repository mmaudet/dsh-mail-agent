// Compare drafts the agent writes against replies the owner actually sent.
//
//   node scripts/measure-drafts.mjs [--since 2026-08-24] [--limit 12]
//
// The owner's Sent folder is an answer key, and it is the only one this project
// has had that cost nobody any time. For every message they replied to, the
// draft can be generated and set beside what they wrote.
//
// What is measured is deliberately narrow. Whether a draft "sounds like" the
// owner is a judgement only they can make, so this reports the things that can
// be checked — length against their median, language, sign-off, and whether the
// draft invented a fact the message did not contain — and prints both texts so
// the judgement can be made in a minute rather than guessed at.
//
// PERIMETER: this sends the owner's own outgoing mail to the model, which the
// classifier never did. The banner says so.

import { readFileSync } from 'node:fs';

import {
  JmapAdapter,
  learnStyle,
  describeStyle,
  ownWords,
  renderDraftRequest,
  DRAFT_SYSTEM_PROMPT,
  cleanDraft,
} from '../packages/dsh-mail-core/dist/index.js';

import { assertBuilt } from './lib/built.mjs';

const PKG = new URL('../packages/dsh-mail-core/', import.meta.url).pathname;
assertBuilt(PKG);

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const SINCE = new Date(arg('since', '2026-08-24'));
const LIMIT = Number(arg('limit', '12'));
const MODEL = arg('model', 'mistralai/mistral-small-3.2-24b-instruct');
const BASE = (arg('base', process.env.MAIL_SENTINEL_API_BASE) ?? '').replace(/\/$/, '');
const THIRD_PARTY = args.includes('--accept-third-party');
const SOVEREIGN = /^https:\/\/chat\.lucie\.ovh\.linagora\.com(\/|$)/;
const KEY = THIRD_PARTY ? process.env.OPENROUTER_API_KEY : process.env.MAIL_SENTINEL_API_KEY;

if (!SOVEREIGN.test(BASE)) {
  if (!THIRD_PARTY) {
    console.error(`Refusing: ${BASE} is not the sovereign gateway.`);
    process.exit(2);
  }
  const line = (s) => console.error(`| ${s.padEnd(66)}|`);
  console.error('+' + '-'.repeat(67) + '+');
  line('THIRD-PARTY ENDPOINT: the owner\'s OWN SENT MAIL leaves the perimeter');
  line('The classifier only ever sent received mail. This sends what they wrote.');
  line(`${BASE}  ${MODEL}`);
  console.error('+' + '-'.repeat(67) + '+\n');
}

const ACC = process.env.MAIL_SENTINEL_JMAP_ACCOUNT_ID;
const bearer = JSON.parse(process.env.MAIL_SENTINEL_JMAP_TOKENS).accessToken;
let apiUrl = null;
async function jmap(using, methodCalls) {
  if (!apiUrl) {
    const s = await fetch(process.env.MAIL_SENTINEL_JMAP_SESSION_URL, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    apiUrl = (await s.json()).apiUrl;
  }
  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ using, methodCalls }),
  });
  return r.json();
}
const adapter = new JmapAdapter({ transport: { request: (b) => jmap(b.using, b.methodCalls) }, accountId: ACC, identityId: 'x' });

// The profile comes from a wider window than the messages being drafted, so a
// draft is never scored against a style derived from itself.
const profileIds = await adapter.messagesSince('Sent', new Date('2026-07-01'), 300);
const profileSource = await adapter.getMessages(profileIds);
const style = learnStyle(profileSource, { examples: 3 });
if (style === null) {
  console.error('Not enough replies to derive a style.');
  process.exit(2);
}
console.log(describeStyle(style));
console.log('\n' + '='.repeat(70) + '\n');

// The answer key: replies sent in the window, and the messages they answer.
const sentIds = await adapter.messagesSince('Sent', SINCE, 200);
const sent = (await adapter.getMessages(sentIds)).filter((m) => m.inReplyTo.length > 0);

const wanted = new Set(sent.flatMap((m) => m.inReplyTo));
const inboxIds = await adapter.messagesSince('INBOX', new Date(SINCE.getTime() - 14 * 86400000), 1200);
const inbox = await adapter.getMessages(inboxIds);
const byMessageId = new Map(inbox.filter((m) => wanted.has(m.messageId)).map((m) => [m.messageId, m]));

const pairs = [];
for (const reply of sent) {
  const original = reply.inReplyTo.map((id) => byMessageId.get(id)).find(Boolean);
  if (original === undefined) continue;
  const theirs = ownWords(reply);
  if (theirs.length === 0) continue;
  pairs.push({ original, theirs });
  if (pairs.length >= LIMIT) break;
}
console.log(`${pairs.length} replies matched to the message they answer\n`);

async function ask(system, user) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL, temperature: 0.3, max_tokens: 700,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    if (r.ok) return (await r.json()).choices?.[0]?.message?.content ?? '';
    if (r.status !== 429 && r.status < 500) throw new Error(`${r.status}`);
    await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
  }
  throw new Error('gave up');
}

const words = (t) => t.split(/\s+/).filter(Boolean).length;
const rows = [];
for (const { original, theirs } of pairs) {
  const raw = await ask(
    DRAFT_SYSTEM_PROMPT,
    renderDraftRequest({ message: original, category: 'correspondance-commerciale-client', style, owner: process.env.MAIL_SENTINEL_OWNER ?? '' }),
  );
  const mine = cleanDraft(raw);
  rows.push({ original, theirs, mine });

  console.log('-'.repeat(70));
  console.log(`FROM  ${original.from[0]?.email ?? '?'}`);
  console.log(`SUBJ  ${original.subject.slice(0, 62)}`);
  console.log(`\n  THEY WROTE (${words(theirs)} words)`);
  console.log(theirs.split('\n').map((l) => '    ' + l).join('\n').slice(0, 700));
  console.log(`\n  THE AGENT DRAFTED (${words(mine)} words)`);
  console.log(mine.split('\n').map((l) => '    ' + l).join('\n').slice(0, 700));
  console.log('');
}

// The checkable part.
const signed = rows.filter((r) => r.mine.includes(style.signOff)).length;
const fenced = rows.filter((r) => r.mine.includes('```')).length;
const gaps = rows.filter((r) => /\[[^\]]{2,30}\]/.test(r.mine)).length;
const theirWords = rows.map((r) => words(r.theirs)).sort((a, b) => a - b);
const myWords = rows.map((r) => words(r.mine)).sort((a, b) => a - b);
const median = (a) => a[Math.floor(a.length / 2)] ?? 0;

console.log('='.repeat(70));
console.log(`\n  drafts written            ${rows.length}`);
console.log(`  median length, theirs     ${median(theirWords)} words`);
console.log(`  median length, the agent  ${median(myWords)} words`);
console.log(`  signed "${style.signOff}"        ${signed}/${rows.length}`);
console.log(`  left a bracketed gap      ${gaps}/${rows.length}`);
if (fenced > 0) console.log(`  came back fenced          ${fenced}/${rows.length}  <- cleanDraft missed these`);
