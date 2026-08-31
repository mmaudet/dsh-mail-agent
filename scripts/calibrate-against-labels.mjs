// Measure the classifier against labels a person wrote, not against itself.
//
// Every earlier measurement in this repository compared the classifier to its
// own past answers — that is consistency, not correctness. Thirty messages the
// owner labelled blind are the first outside reference this project has had.
//
//   node scripts/calibrate-against-labels.mjs --prompt FILE [--label NAME]
//
// The thirty are pinned by JMAP id, taken from the run that produced the label
// set. Re-sampling by position would silently return a different thirty — this
// inbox takes 200 messages a day — and the labels would line up with the wrong
// mail while still producing a plausible-looking percentage.
//
// PERIMETER. By default this refuses any endpoint but the sovereign gateway,
// because real message content goes into every prompt. `--accept-third-party`
// overrides that for one run and prints a banner saying so. It exists because
// the owner asked for it while the gateway's certificate is expired. It is
// never the default, and never silent.

import { readFileSync, writeFileSync } from 'node:fs';

import { JmapAdapter } from '../packages/dsh-mail-core/dist/adapters/jmap-adapter.js';
import { renderMessage } from '../packages/dsh-mail-core/dist/cascade/llm-classifier.js';

const args = process.argv.slice(2);
const arg = (n, fallback = null) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? fallback : args[i + 1];
};

const PROMPT = readFileSync(arg('prompt'), 'utf8');
const LABELS = JSON.parse(readFileSync(arg('labels', '/tmp/human-labels.json'), 'utf8'));
const PINNED = JSON.parse(readFileSync(arg('ids', '/tmp/label-predictions.json'), 'utf8'));
const RUN = arg('label', 'run');
const OUT = arg('out', `/tmp/calibration-${RUN}.json`);

const SOVEREIGN = /^https:\/\/chat\.lucie\.ovh\.linagora\.com(\/|$)/;
const API_BASE = (arg('base', process.env.MAIL_SENTINEL_API_BASE) ?? '').replace(/\/$/, '');
const MODEL = arg('model', 'Mistral-Small-3.2-24B-Instruct-2506-FP8');
const THIRD_PARTY = args.includes('--accept-third-party');

if (!SOVEREIGN.test(API_BASE)) {
  if (!THIRD_PARTY) {
    console.error(`Refusing: ${API_BASE} is not the sovereign gateway.`);
    console.error('Real message content goes into every prompt. Pass --accept-third-party');
    console.error('only when the owner has said so for this run.');
    process.exit(2);
  }
  const line = (s) => console.error(`| ${s.padEnd(62)}|`);
  console.error('+' + '-'.repeat(63) + '+');
  line('THIRD-PARTY ENDPOINT: message content leaves the perimeter');
  line(`endpoint: ${API_BASE}`);
  line(`model:    ${MODEL}`);
  line('30 real messages from mmaudet@linagora.com will be sent there.');
  console.error('+' + '-'.repeat(63) + '+');
}

const API_KEY = THIRD_PARTY ? process.env.OPENROUTER_API_KEY : process.env.MAIL_SENTINEL_API_KEY;
if (!API_KEY) {
  console.error('No API key for the chosen endpoint.');
  process.exit(2);
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
    body: JSON.stringify({
      using,
      methodCalls,
    }),
  });
  return r.json();
}

const adapter = new JmapAdapter({
  transport: { request: (b) => jmap(b.using, b.methodCalls) },
  accountId: ACC,
  identityId: 'x',
});

const byId = new Map((await adapter.getMessages(PINNED.map((p) => p.id))).map((m) => [m.id, m]));
const missing = PINNED.filter((p) => !byId.has(p.id));
if (missing.length > 0) {
  // A message the owner labelled has been moved or deleted since. Scoring the
  // remainder is fine; pretending the set is still thirty is not.
  console.error(`${missing.length} of ${PINNED.length} labelled messages are no longer retrievable.`);
}

const context = {
  owner: process.env.MAIL_SENTINEL_OWNER ?? 'mmaudet@linagora.com',
  vipSenders: [],
  corporateDomains: ['linagora.com'],
  threadCategory: null,
  learnedPatterns: [],
};

async function classify(message) {
  const r = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 256,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: renderMessage(message, context) },
      ],
    }),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 140)}`);
  const text = (await r.json()).choices?.[0]?.message?.content ?? '';
  const m = /"category"\s*:\s*"([a-z-]+)"/.exec(text);
  if (!m) throw new Error(`no category in: ${text.slice(0, 100)}`);
  return m[1];
}

const rows = [];
for (const pin of PINNED) {
  const truth = LABELS[String(pin.n)];
  const message = byId.get(pin.id);
  if (!truth || !message) continue;
  let guess;
  try {
    guess = await classify(message);
  } catch (err) {
    guess = `ERROR(${String(err.message).slice(0, 50)})`;
  }
  const subject = (message.subject || '(no subject)').slice(0, 44);
  rows.push({ n: pin.n, truth, guess, subject });
  console.log(
    `${guess === truth ? '  ' : '! '}${String(pin.n).padStart(2)}  ` +
      `${truth.padEnd(14)} ${guess.padEnd(26)} ${subject}`,
  );
}

const scored = rows.filter((r) => !r.guess.startsWith('ERROR'));
const errors = rows.length - scored.length;
const right = scored.filter((r) => r.guess === r.truth).length;

console.log(`\n  ${RUN}: ${right}/${scored.length} agree (${Math.round((right / scored.length) * 100)}%)` +
  (errors > 0 ? `, ${errors} errored` : ''));

const tally = (key) => {
  const c = {};
  for (const r of scored) c[r[key]] = (c[r[key]] ?? 0) + 1;
  return c;
};
const owner = tally('truth');
const model = tally('guess');
console.log('\n  category                  owner   model');
for (const cat of [...new Set([...Object.keys(owner), ...Object.keys(model)])].sort()) {
  console.log(`  ${cat.padEnd(25)} ${String(owner[cat] ?? 0).padStart(5)}   ${String(model[cat] ?? 0).padStart(5)}`);
}

// Where it goes wrong says more than how often.
const confusions = {};
for (const r of scored) {
  if (r.guess === r.truth) continue;
  const k = `${r.truth} -> ${r.guess}`;
  confusions[k] = (confusions[k] ?? 0) + 1;
}
const ranked = Object.entries(confusions).sort((a, b) => b[1] - a[1]);
if (ranked.length > 0) {
  console.log('\n  most common mistakes');
  for (const [k, n] of ranked.slice(0, 8)) console.log(`  ${String(n).padStart(3)}  ${k}`);
}

writeFileSync(OUT, JSON.stringify({ run: RUN, model: MODEL, rows }, null, 2));
console.log(`\n  written to ${OUT}`);
