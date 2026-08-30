// Can the agent find the messages that are actually waiting on the owner?
//
//   node scripts/measure-dispositions.mjs --key notes.json --accept-third-party
//
// The owner annotated forty queued messages with what each one asked of them
// (docs/reviews/forty-dispositions.md). Nine wanted something; the other
// thirty-one were information, or had already been answered. That is an answer
// key for the question the queue exists to answer, and every measurement this
// project has made so far has been about the sixteen categories instead.
//
// The key is the owner's private annotation of their own mail and is not in
// this repository. Pass it with --key as
//   [{ "id": "...", "disposition": "reply|act|handled|information" }, ...]
//
// What is scored is the binary the queue actually asks: does this want
// something from the owner, or not? Accuracy is not reported, because a model
// that answers "no" to everything scores 70% on this distribution and offers
// the owner an empty queue.

import { readFileSync } from 'node:fs';

import { JmapAdapter, addressingOf } from '../packages/dsh-mail-core/dist/index.js';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const KEY = arg('key', null);
const MODEL = arg('model', 'mistralai/mistral-small-3.2-24b-instruct');
const BASE = (arg('base', process.env.MAIL_SENTINEL_API_BASE) ?? '').replace(/\/$/, '');
const PROMPT = arg('prompt', 'action');
// A reasoning model spends its budget thinking and answers with nothing at all
// when the cap is eight. Qwen scored 0% here before this existed, which was a
// measurement of the harness rather than of the model.
const MAX_TOKENS = Number(arg('max-tokens', '8'));
const THIRD_PARTY = args.includes('--accept-third-party');
const SOVEREIGN = /^https:\/\/chat\.lucie\.ovh\.linagora\.com(\/|$)/;
const OWN = (arg('own', process.env.MAIL_SENTINEL_OWN_ADDRESSES) ?? process.env.MAIL_SENTINEL_OWNER ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '');

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
  line("THIRD-PARTY ENDPOINT: received mail bodies leave the perimeter");
  line('Forty real messages, subjects and bodies, sent for classification.');
  line(`${ENDPOINT}  ${MODEL}`);
  console.error('+' + '-'.repeat(67) + '+\n');
}

// Two prompts, because the first version of this question was already wrong
// once: "is a human waiting on the owner?" caught most of a work inbox.
const PROMPTS = {
  // What the classifier's own prompt says today, reduced to the binary.
  waiting: [
    'You read one email addressed to the owner of a mailbox.',
    '',
    'Answer YES if a human is waiting on the owner because of this message.',
    'Answer NO otherwise.',
    '',
    'Reply with one word: YES or NO.',
  ].join('\n'),
  // What the owner's own forty notes say the line actually is.
  action: [
    'You read one email that reached the owner of a mailbox.',
    '',
    'Answer YES only if it asks for something that the owner personally has to',
    'do: write a reply that has not been written, sign, validate, approve,',
    'renew, or answer a question put to them.',
    '',
    'Answer NO if it only keeps them informed. That includes: an exchange',
    'between other people that they are copied on, a status report, a delivery',
    'or platform notification about something already in motion, a meeting',
    'confirmation, and anything addressed to a team they belong to where a',
    'colleague is the one being asked.',
    '',
    'Most mail in this inbox is NO. Reply with one word: YES or NO.',
  ].join('\n'),
};

if (!(PROMPT in PROMPTS)) {
  console.error(`Refusing: --prompt must be one of ${Object.keys(PROMPTS).join(', ')}`);
  process.exit(2);
}

const ACC = process.env.MAIL_SENTINEL_JMAP_ACCOUNT_ID;
const bearer = JSON.parse(process.env.MAIL_SENTINEL_JMAP_TOKENS).accessToken;
let apiUrl = null;
async function jmap(methodCalls) {
  if (apiUrl === null) {
    const s = await fetch(process.env.MAIL_SENTINEL_JMAP_SESSION_URL, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    apiUrl = (await s.json()).apiUrl;
  }
  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls }),
  });
  return r.json();
}

async function ask(user) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const r = await fetch(`${ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${APIKEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: PROMPTS[PROMPT] },
          { role: 'user', content: user },
        ],
      }),
    });
    if (r.ok) return (await r.json()).choices?.[0]?.message?.content ?? '';
    if (r.status !== 429 && r.status < 500) throw new Error(`${String(r.status)} ${await r.text()}`);
    await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
  }
  throw new Error('gave up');
}

const notes = JSON.parse(readFileSync(KEY, 'utf8'));
const key = new Map(notes.map((r) => [r.id, r.disposition]));
// The queue removes what the owner has already answered before a model sees
// anything, on an exact join rather than a judgement. Measuring the model on
// those would score it for not knowing what is in the Sent folder.
const done = new Set(notes.filter((r) => r.already).map((r) => r.id));
const adapter = new JmapAdapter({
  transport: { request: (b) => jmap(b.methodCalls) },
  accountId: ACC,
  identityId: 'x',
});
const messages = await adapter.getMessages([...key.keys()]);

const scored = messages.filter((m) => !done.has(m.id) && key.get(m.id) !== 'handled');
const wants = (d) => d === 'reply' || d === 'act';

const render = (m) => {
  const addressing = addressingOf(m, OWN);
  const body = (m.bodyText ?? m.preview ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('>'))
    .join('\n')
    .trim()
    .slice(0, 1200);
  return [
    `From: ${m.from[0]?.name ?? ''} <${m.from[0]?.email ?? ''}>`,
    `To: ${m.to.map((a) => a.email).join(', ')}`,
    m.cc.length > 0 ? `Cc: ${m.cc.map((a) => a.email).join(', ')}` : null,
    `Addressed: ${addressing === 'personal' ? 'to the owner' : 'to a list the owner is on'}`,
    `Subject: ${m.subject}`,
    '',
    body,
  ]
    .filter((l) => l !== null)
    .join('\n');
};

// The last verdict word in the reply, not the first character of it: a model
// that reasons aloud opens with anything and closes with the answer.
const verdict = (text) => {
  const found = text.toUpperCase().match(/\b(YES|NO)\b/g);
  return found === null ? null : found[found.length - 1] === 'YES';
};

const rows = [];
let unparsed = 0;
for (const m of scored) {
  const answer = verdict(await ask(render(m)));
  if (answer === null) unparsed += 1;
  // An unreadable answer is offered rather than hidden: the queue's failure
  // mode has to be showing too much, never dropping something silently.
  const said = answer ?? true;
  const truth = wants(key.get(m.id));
  rows.push({ m, said, truth });
  process.stderr.write(said === truth ? '.' : 'X');
}
process.stderr.write('\n\n');

const tp = rows.filter((r) => r.said && r.truth).length;
const fp = rows.filter((r) => r.said && !r.truth).length;
const fn = rows.filter((r) => !r.said && r.truth).length;
const tn = rows.filter((r) => !r.said && !r.truth).length;
const pct = (a, b) => (b === 0 ? ' —' : `${String(Math.round((a / b) * 100)).padStart(3)}%`);

console.log(`${MODEL}   prompt: ${PROMPT}   ${String(rows.length)} messages, ${String(tp + fn)} of them waiting`);
if (unparsed > 0) console.log(`  ${String(unparsed)} answers had no YES or NO in them, counted as yes`);
console.log('');
console.log('                 model says yes   model says no');
console.log(`  waiting        ${String(tp).padStart(8)}       ${String(fn).padStart(8)}`);
console.log(`  not waiting    ${String(fp).padStart(8)}       ${String(tn).padStart(8)}`);
console.log(`\n  recall     ${pct(tp, tp + fn)}   of what was waiting, offered`);
console.log(`  precision  ${pct(tp, tp + fp)}   of what was offered, waiting`);
console.log(`  queue      ${String(tp + fp)} long, against ${String(rows.length)} today and ${String(tp + fn)} ideal`);

console.log('\n  baselines on the same set');
const always = rows.length;
console.log(`    offer everything          recall  100%   precision ${pct(tp + fn, always)}   queue ${String(always)}`);
const personal = rows.filter((r) => addressingOf(r.m, OWN) === 'personal');
console.log(
  `    offer what names them     recall ${pct(personal.filter((r) => r.truth).length, tp + fn)}   ` +
    `precision ${pct(personal.filter((r) => r.truth).length, personal.length)}   queue ${String(personal.length)}`,
);

// Neither test dominates the other, so the two ways of putting them together
// are worth the four lines it takes to print them.
const named = (r) => addressingOf(r.m, OWN) === 'personal';
for (const [label, keep] of [
  ['either the model or the addressing', (r) => r.said || named(r)],
  ['both the model and the addressing', (r) => r.said && named(r)],
]) {
  const offered = rows.filter(keep);
  const right = offered.filter((r) => r.truth).length;
  console.log(
    `    ${label.padEnd(35)} recall ${pct(right, tp + fn)}   precision ${pct(right, offered.length)}   queue ${String(offered.length)}`,
  );
}

console.log('\n  missed — waiting, and the model said no');
for (const r of rows.filter((x) => !x.said && x.truth)) console.log(`    ${r.m.subject.slice(0, 62)}`);
console.log('\n  offered anyway — not waiting, and the model said yes');
for (const r of rows.filter((x) => x.said && !x.truth)) console.log(`    ${r.m.subject.slice(0, 62)}`);
