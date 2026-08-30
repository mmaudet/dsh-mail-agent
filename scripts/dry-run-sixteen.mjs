// Run the real cascade over a real mailbox under the sixteen-category
// vocabulary, and write nothing.
//
//   node scripts/dry-run-sixteen.mjs [--limit 400] [--accept-third-party]
//
// Three questions, in order of how much they matter.
//
// 1. WHAT WOULD THE TRASH RULE TAKE. Cold prospecting is 16% of this mailbox
//    and it is the only category the owner authorised removing unattended.
//    Every message that rule would take is listed by subject and sender,
//    because a 16% automatic deletion nobody has read is not a feature.
// 2. CAN THE CHEAP MODEL HIT SIXTEEN CATEGORIES. The vocabulary was derived by
//    a large model; production runs a 24B one. Agreement between them is
//    measurable now, and it is a different question from whether the taxonomy
//    is right — which only the owner's labels can answer.
// 3. WHAT DOES THE CASCADE STILL SETTLE FOR FREE. Node 4 lost the bulk rule
//    and gained List-Id, and the corpus said that trade costs 10 points. This
//    is the same trade measured on real mail rather than on twelve fixtures.
//
// PERIMETER: real message content leaves for a third-party model unless the
// endpoint is the sovereign gateway. The banner names it.

import { readFileSync, writeFileSync } from 'node:fs';

import { JmapAdapter } from '../packages/dsh-mail-core/dist/adapters/jmap-adapter.js';
import { runCascade } from '../packages/dsh-mail-core/dist/cascade/cascade-loop.js';
import { createLlmClassifier } from '../packages/dsh-mail-core/dist/cascade/llm-classifier.js';
import { planActions, automatic } from '../packages/dsh-mail-core/dist/actions/plan.js';
import { DEFAULT_POLICY } from '../packages/dsh-mail-core/dist/actions/approval.js';
import { bandOf } from '../packages/dsh-mail-core/dist/types.js';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const LIMIT = Number(arg('limit', '400'));
const CONCURRENCY = Number(arg('concurrency', '6'));
const THIRD_PARTY = args.includes('--accept-third-party');
const SOVEREIGN = /^https:\/\/chat\.lucie\.ovh\.linagora\.com(\/|$)/;
const BASE = (arg('base', process.env.MAIL_SENTINEL_API_BASE) ?? '').replace(/\/$/, '');
const MODEL = arg('model', 'Mistral-Small-3.2-24B-Instruct-2506-FP8');
const KEY = THIRD_PARTY ? process.env.OPENROUTER_API_KEY : process.env.MAIL_SENTINEL_API_KEY;
const REFERENCE = arg('reference', '/tmp/taxonomy-validation.json');
// Named after the model: two runs used to write the same path, so comparing
// two models meant the second silently ate the first.
const OUT = arg('out', `/tmp/dry-run-${MODEL.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`);
const PINNED = arg('pinned', '/tmp/taxonomy-corpus.json');

if (!SOVEREIGN.test(BASE)) {
  if (!THIRD_PARTY) {
    console.error(`Refusing: ${BASE} is not the sovereign gateway.`);
    console.error('Pass --accept-third-party only when the owner has said so for this run.');
    process.exit(2);
  }
  const line = (s) => console.error(`| ${s.padEnd(62)}|`);
  console.error('+' + '-'.repeat(63) + '+');
  line('THIRD-PARTY ENDPOINT: message content leaves the perimeter');
  line(`${BASE}  ${MODEL}`);
  console.error('+' + '-'.repeat(63) + '+\n');
}
if (!KEY) {
  console.error('No API key for the chosen endpoint.');
  process.exit(2);
}

const ACC = process.env.MAIL_SENTINEL_JMAP_ACCOUNT_ID;
const bearer = JSON.parse(process.env.MAIL_SENTINEL_JMAP_TOKENS).accessToken;
let apiUrl = null;
async function jmap(methodCalls) {
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
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls,
    }),
  });
  return r.json();
}

const adapter = new JmapAdapter({
  transport: { request: (b) => jmap(b.methodCalls) },
  accountId: ACC,
  identityId: 'x',
});

// The same messages the taxonomy was derived from, pinned by id: a fresh
// sample would compare two different mailboxes and call it disagreement.
const pinned = JSON.parse(readFileSync(PINNED, 'utf8')).slice(0, LIMIT);
const messages = await adapter.getMessages(pinned.map((p) => p.id));
const byId = new Map(messages.map((m) => [m.id, m]));

const reference = new Map(
  JSON.parse(readFileSync(REFERENCE, 'utf8')).map((r) => [r.n, r.categorie]),
);

const llm = {
  async *stream(options) {
    // A 429 is the provider pacing us, not a verdict about the message. The
    // first run lost 20 of 400 messages to rate limits and reported them
    // beside genuine parse failures, which reads as a model problem.
    let r = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      r = await fetchOnce(options);
      if (r.status !== 429 && r.status < 500) break;
      await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt));
    }
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
    const body = await r.json();
    yield { type: 'text-delta', index: 0, text: body.choices?.[0]?.message?.content ?? '' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};

function fetchOnce(options) {
  return fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: options.model,
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: 'system', content: options.system },
        { role: 'user', content: options.messages[0].content.map((b) => b.text).join('') },
      ],
    }),
  });
}

const model = createLlmClassifier({ llm, provider: 'mail-llm-economy', model: MODEL });
const context = {
  owner: process.env.MAIL_SENTINEL_OWNER ?? 'mmaudet@linagora.com',
  vipSenders: [],
  corporateDomains: ['linagora.com'],
  threadCategory: null,
  learnedPatterns: [],
};
const JMAP_LIKE = { customKeywords: true, spamHeaders: true, serverSideSearch: true, push: true };

const rows = [];
let done = 0;
async function worker(queue) {
  for (;;) {
    const pin = queue.shift();
    if (pin === undefined) return;
    const message = byId.get(pin.id);
    if (message === undefined) continue;
    let trace;
    try {
      trace = await runCascade(message, { context, model });
    } catch (err) {
      rows.push({ n: pin.n, error: String(err.message).slice(0, 80) });
      continue;
    }
    const plan = planActions(trace, JMAP_LIKE, DEFAULT_POLICY);
    rows.push({
      n: pin.n,
      category: trace.category,
      confidence: trace.confidence,
      decidedBy: trace.decidedBy,
      reference: reference.get(pin.n) ?? null,
      auto: automatic(plan).map((p) => p.action),
      from: `${message.from[0]?.name ?? ''} <${message.from[0]?.email ?? ''}>`.trim(),
      subject: (message.subject || '(sans objet)').slice(0, 58),
    });
    done += 1;
    if (done % 20 === 0) process.stderr.write(`\r  ${done}/${pinned.length}`);
  }
}
const queue = [...pinned];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
process.stderr.write(`\r  ${done}/${pinned.length}\n`);
rows.sort((a, b) => a.n - b.n);
writeFileSync(OUT, JSON.stringify(rows, null, 2));

const ok = rows.filter((r) => r.category !== undefined);
const failed = rows.length - ok.length;

// --- 1. what the trash rule would take -------------------------------------

const trashed = ok.filter((r) => r.auto.includes('trash'));
console.log(`\n  THE TRASH RULE WOULD TAKE ${trashed.length} OF ${ok.length} (${Math.round((trashed.length / ok.length) * 100)}%)\n`);
for (const r of trashed) {
  const agrees = r.reference === r.category ? ' ' : '!';
  console.log(`  ${agrees} ${String(r.n).padStart(3)}  ${r.confidence.toFixed(2)}  ${r.subject}`);
  console.log(`         ${r.from.slice(0, 66)}${r.reference !== r.category ? `   [large model said: ${r.reference}]` : ''}`);
}
const disputed = trashed.filter((r) => r.reference !== r.category);
console.log(`\n  ${disputed.length} of those ${trashed.length} the large model called something else.`);
const wouldKeep = ok.filter((r) => r.reference === 'prospection-commerciale-non-sollicitee' && !r.auto.includes('trash'));
console.log(`  ${wouldKeep.length} the large model called prospecting, the cheap one did not take.`);

// --- 2. can the cheap model hit sixteen ------------------------------------

const scored = ok.filter((r) => r.reference !== null && r.reference !== 'autre');
const agree = scored.filter((r) => r.reference === r.category).length;
const bandAgree = scored.filter((r) => {
  try { return bandOf(r.reference) === bandOf(r.category); } catch { return false; }
}).length;
console.log(`\n  AGREEMENT WITH THE MODEL THAT DERIVED THE VOCABULARY`);
console.log(`  exact category : ${agree}/${scored.length} (${Math.round((agree / scored.length) * 100)}%)`);
console.log(`  same band      : ${bandAgree}/${scored.length} (${Math.round((bandAgree / scored.length) * 100)}%)`);

const confusion = {};
for (const r of scored) {
  if (r.reference === r.category) continue;
  const k = `${r.reference} -> ${r.category}`;
  confusion[k] = (confusion[k] ?? 0) + 1;
}
console.log('\n  where they part company');
for (const [k, n] of Object.entries(confusion).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(n).padStart(4)}  ${k}`);
}

// --- 3. what the cascade settles for free ----------------------------------

const nodes = {};
for (const r of ok) nodes[r.decidedBy] = (nodes[r.decidedBy] ?? 0) + 1;
const free = ok.filter((r) => r.decidedBy !== 'llm' && r.decidedBy !== 'below-threshold').length;
console.log(`\n  SETTLED WITHOUT A MODEL CALL: ${free}/${ok.length} (${Math.round((free / ok.length) * 100)}%)`);
for (const [k, n] of Object.entries(nodes).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${k}`);
}

const dist = {};
for (const r of ok) dist[r.category] = (dist[r.category] ?? 0) + 1;
const refDist = {};
for (const r of scored) refDist[r.reference] = (refDist[r.reference] ?? 0) + 1;
console.log('\n  category                                  cheap   large');
for (const cat of [...new Set([...Object.keys(dist), ...Object.keys(refDist)])].sort()) {
  console.log(`  ${cat.padEnd(41)} ${String(dist[cat] ?? 0).padStart(5)}   ${String(refDist[cat] ?? 0).padStart(5)}`);
}
if (failed > 0) console.log(`\n  ${failed} messages errored.`);
console.log(`\n  written to ${OUT}`);
