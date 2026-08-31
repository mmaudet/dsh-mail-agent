// Does one line from the owner close the gap a draft cannot close alone?
//
//   node scripts/measure-instructed-drafts.mjs --key notes.json --accept-third-party
//
// The question came from the owner, not from the project: they observed that a
// foundation model given only the message body and one line of intent writes
// something nearly sendable, while the agent's own drafts came back right in
// style and empty in substance.
//
// Both sides of that now exist for the same messages. The owner annotated forty
// queued messages with what each asked of them, and for the ones they had
// already answered, their real reply is in Sent. So the note is the instruction,
// the sent reply is the answer key, and the same message can be drafted twice —
// with the instruction and without — and set beside what they actually wrote.
//
// The key is the owner's private annotation of their own mail and is not in
// this repository. Pass it with --key as
//   [{ "id": "...", "note": "..." }, ...]
//
// Their notes turned out to be retrospective — "je l'ai réalisée", "il
// suffisait de lui confirmer" — written about mail already dealt with, which is
// not the forward instruction the interface collects. So --derive also runs a
// second condition: a model reduces the owner's actual reply to the one line
// they would have dictated to get it, and the draft is written from that. It is
// circular by construction, and that is the point — it is the upper bound on
// what one line can carry, and if a perfect line is not enough then no
// interface that collects one can work.
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

const KEY = arg('key', null);
const DERIVE = args.includes('--derive');
const MODEL = arg('model', 'mistralai/mistral-small-3.2-24b-instruct');
const BASE = (arg('base', process.env.MAIL_SENTINEL_API_BASE) ?? '').replace(/\/$/, '');
const OWNER = process.env.MAIL_SENTINEL_OWNER ?? '';
const THIRD_PARTY = args.includes('--accept-third-party');
const SOVEREIGN = /^https:\/\/chat\.lucie\.ovh\.linagora\.com(\/|$)/;

if (KEY === null) {
  console.error('Refusing: --key is required, and its contents never enter this repository.');
  process.exit(2);
}

const ENDPOINT = THIRD_PARTY ? 'https://openrouter.ai/api/v1' : BASE;
const APIKEY = THIRD_PARTY ? process.env.OPENROUTER_API_KEY : process.env.MAIL_SENTINEL_API_KEY;

if (!SOVEREIGN.test(ENDPOINT)) {
  if (!THIRD_PARTY) {
    console.error(`Refusing: ${ENDPOINT} is not the sovereign gateway.`);
    process.exit(2);
  }
  const line = (s) => console.error(`| ${s.padEnd(66)}|`);
  console.error('+' + '-'.repeat(67) + '+');
  line("THIRD-PARTY ENDPOINT: the owner's OWN SENT MAIL leaves the perimeter");
  line('Their replies, their notes, and the messages both answer.');
  line(`${ENDPOINT}  ${MODEL}`);
  console.error('+' + '-'.repeat(67) + '+\n');
}

const ACC = process.env.MAIL_SENTINEL_JMAP_ACCOUNT_ID;
const bearer = JSON.parse(process.env.MAIL_SENTINEL_JMAP_TOKENS).accessToken;
let apiUrl = null;
async function jmap(using, methodCalls) {
  if (apiUrl === null) {
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
const adapter = new JmapAdapter({
  transport: { request: (b) => jmap(b.using, b.methodCalls) },
  accountId: ACC,
  identityId: 'x',
});

// A wider window than the messages being drafted, so no draft is scored
// against a style derived from itself.
const profile = await adapter.getMessages(await adapter.messagesSince('Sent', new Date('2026-07-01'), 300));
const style = learnStyle(profile, { examples: 3 });
if (style === null) {
  console.error('Not enough replies to derive a style.');
  process.exit(2);
}
console.log(describeStyle(style));
console.log('\n' + '='.repeat(72) + '\n');

const notes = new Map(JSON.parse(readFileSync(KEY, 'utf8')).map((r) => [r.id, r.note]));
const annotated = await adapter.getMessages([...notes.keys()]);
const sent = (await adapter.getMessages(await adapter.messagesSince('Sent', new Date('2026-08-17'), 400)))
  .filter((m) => m.inReplyTo.length > 0);

// The pairs: a message the owner annotated *and* answered.
const pairs = [];
for (const original of annotated) {
  const reply = sent.find((m) => m.inReplyTo.includes(original.messageId ?? ' '));
  if (reply === undefined) continue;
  const theirs = ownWords(reply);
  if (theirs.length === 0) continue;
  pairs.push({ original, theirs, instruction: notes.get(original.id) ?? '' });
}
console.log(`${String(pairs.length)} messages the owner both annotated and answered\n`);

async function ask(user) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const r = await fetch(`${ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${APIKEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 900,
        messages: [
          { role: 'system', content: DRAFT_SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
      }),
    });
    if (r.ok) return (await r.json()).choices?.[0]?.message?.content ?? '';
    if (r.status !== 429 && r.status < 500) throw new Error(`${String(r.status)}`);
    await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
  }
  throw new Error('gave up');
}

const words = (t) => t.split(/\s+/).filter(Boolean).length;

// Content words the two texts share. A poor measure of a reply, and the only
// one available without asking the owner to read twenty drafts. It is reported
// as a difference between two drafts of the same message, never as a score.
const STOP = new Set(
  (
    'le la les un une des de du au aux et ou a en pour par sur dans que qui quoi ce cette ces ' +
    'je tu il elle nous vous ils elles me te se son sa ses leur leurs mon ma mes votre vos notre nos ' +
    'est sont ete avoir etre fait faire bien tres plus bonjour cordialement merci'
  ).split(' '),
);
const bag = (t) =>
  new Set(
    t
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .match(/[a-z0-9]{3,}/g)
      ?.filter((w) => !STOP.has(w)) ?? [],
  );
const overlap = (a, b) => {
  const x = bag(a);
  const y = bag(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.min(x.size, y.size);
};

const indent = (t) => t.split('\n').join('\n    ').slice(0, 700);

// Reduces a reply to the line that would have produced it. Deliberately not
// allowed to reuse its wording: an instruction that carries the sentences is
// not an instruction, it is the answer.
const DERIVE_SYSTEM = [
  'Below is a reply somebody sent. Write the single short line they would have',
  'said out loud to have an assistant draft it for them — what to say, not how',
  'to say it.',
  '',
  'Use your own words. Do not reuse their sentences or their phrasing. Do not',
  'include a greeting or a sign-off. One line, under twenty words, in French.',
  'Answer with the line and nothing else.',
].join('\n');

async function askWith(system, user) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const r = await fetch(`${ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${APIKEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 120,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (r.ok) return (await r.json()).choices?.[0]?.message?.content ?? '';
    if (r.status !== 429 && r.status < 500) throw new Error(`${String(r.status)}`);
    await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
  }
  throw new Error('gave up');
}

const rows = [];
for (const { original, theirs, instruction } of pairs) {
  const base = { message: original, category: 'correspondance-commerciale-client', style, owner: OWNER };
  const blind = cleanDraft(await ask(renderDraftRequest(base)));
  const told = cleanDraft(await ask(renderDraftRequest({ ...base, instruction })));
  let derived = '';
  let fromDerived = '';
  if (DERIVE) {
    derived = (await askWith(DERIVE_SYSTEM, theirs)).trim().split('\n')[0] ?? '';
    fromDerived = cleanDraft(await ask(renderDraftRequest({ ...base, instruction: derived })));
  }
  rows.push({ theirs, blind, told, derived, fromDerived });

  console.log('-'.repeat(72));
  console.log(`  ${original.subject.slice(0, 66)}`);
  console.log(`\n  the owner said:  ${instruction.slice(0, 220)}`);
  console.log(`\n  they wrote (${String(words(theirs))} words):\n    ${indent(theirs)}`);
  console.log(
    `\n  drafted blind (${String(words(blind))} words, ${String(Math.round(overlap(blind, theirs) * 100))}% shared):\n    ${indent(blind)}`,
  );
  console.log(
    `\n  drafted from their note (${String(words(told))} words, ${String(Math.round(overlap(told, theirs) * 100))}% shared):\n    ${indent(told)}\n`,
  );
  if (DERIVE) {
    const row = rows[rows.length - 1];
    console.log(`  the line their reply implies:  ${row.derived}`);
    console.log(
      `\n  drafted from that line (${String(words(row.fromDerived))} words, ${String(Math.round(overlap(row.fromDerived, theirs) * 100))}% shared):\n    ${indent(row.fromDerived)}\n`,
    );
  }
}

console.log('='.repeat(72));
const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const blindOverlap = rows.map((r) => overlap(r.blind, r.theirs));
const toldOverlap = rows.map((r) => overlap(r.told, r.theirs));
console.log(`\n  ${String(rows.length)} drafts, each written twice from the same message\n`);
console.log('  content words shared with what the owner actually sent');
console.log(`    drafted blind             ${String(Math.round(mean(blindOverlap) * 100)).padStart(3)}%`);
console.log(`    drafted from their note   ${String(Math.round(mean(toldOverlap) * 100)).padStart(3)}%`);
const derivedOverlap = rows.map((r) => overlap(r.fromDerived, r.theirs));
if (DERIVE) {
  console.log(`    drafted from a real line  ${String(Math.round(mean(derivedOverlap) * 100)).padStart(3)}%`);
}
console.log(
  `\n    note beats blind          ${String(rows.filter((_, i) => (toldOverlap[i] ?? 0) > (blindOverlap[i] ?? 0)).length)}/${String(rows.length)}`,
);
if (DERIVE) {
  console.log(
    `    line beats blind          ${String(rows.filter((_, i) => (derivedOverlap[i] ?? 0) > (blindOverlap[i] ?? 0)).length)}/${String(rows.length)}`,
  );
}

// A one-word send and a draft the model declined to write are not answer keys,
// and both turned up in ten real pairs. They are reported rather than dropped
// silently, because deciding what counts is exactly where a measurement bends.
const usable = rows.filter((r) => words(r.theirs) >= 5 && r.blind !== '' && (!DERIVE || r.fromDerived !== ''));
if (usable.length < rows.length) {
  const keep = (xs) => xs.filter((_, i) => usable.includes(rows[i]));
  console.log(`\n  excluding ${String(rows.length - usable.length)} pair(s) with no usable answer key`);
  console.log(`    drafted blind             ${String(Math.round(mean(keep(blindOverlap)) * 100)).padStart(3)}%`);
  console.log(`    drafted from their note   ${String(Math.round(mean(keep(toldOverlap)) * 100)).padStart(3)}%`);
  if (DERIVE) {
    console.log(`    drafted from a real line  ${String(Math.round(mean(keep(derivedOverlap)) * 100)).padStart(3)}%`);
  }
}
console.log(`\n  length, against the owner's median of ${String(style.medianWords)} words`);
console.log(`    they wrote                ${String(Math.round(mean(rows.map((r) => words(r.theirs))))).padStart(3)}`);
console.log(`    drafted blind             ${String(Math.round(mean(rows.map((r) => words(r.blind))))).padStart(3)}`);
console.log(`    drafted from their note   ${String(Math.round(mean(rows.map((r) => words(r.told))))).padStart(3)}`);
if (DERIVE) {
  console.log(`    drafted from a real line  ${String(Math.round(mean(rows.map((r) => words(r.fromDerived))))).padStart(3)}`);
}
