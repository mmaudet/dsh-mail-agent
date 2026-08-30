// Does the learning path actually recover the efficiency the removed rules cost?
//
//   node scripts/measure-learning.mjs [--verdicts /tmp/dry-run-mistral.json]
//
// Two static rules were removed for guessing, and cold-start efficiency fell to
// 3%. The claim made in their place was that node 3 would earn back what they
// asserted, on the evidence that of 36 distinct `List-Id` values in the sample,
// none was sometimes list traffic and sometimes not.
//
// A claim, until this. It replays real verdicts into a real store, runs the
// real learning pass, and reports what the next pass over the same mail would
// settle without a model call.
//
// No model call, no mailbox. Reads a dry run's output and the corpus it came
// from.

import { readFileSync } from 'node:fs';

import { MailStore, learn, describeLearn } from '../packages/dsh-mail-core/dist/index.js';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const verdicts = JSON.parse(readFileSync(arg('verdicts', '/tmp/dry-run-mistral.json'), 'utf8'))
  .filter((r) => r.category);
const corpus = JSON.parse(readFileSync(arg('corpus', '/tmp/taxonomy-corpus.json'), 'utf8'));
const byN = new Map(corpus.map((m) => [m.n, m]));
const addrOf = (from) => (/<([^>]+)>/.exec(from ?? '') ?? [, from ?? ''])[1].toLowerCase().trim();

const store = new MailStore(':memory:');
let recorded = 0;
for (const v of verdicts) {
  const m = byN.get(v.n);
  if (m === undefined) continue;
  store.recordTrace(
    {
      messageId: `m${String(v.n)}`,
      decidedBy: v.decidedBy,
      category: v.category,
      confidence: v.confidence,
      rationale: '',
      steps: [],
      usedModel: v.decidedBy === 'llm',
      startedAt: new Date(),
      durationMs: 0,
    },
    { sender: addrOf(m.from), listId: m.listId ?? null },
  );
  recorded += 1;
}

console.log(`  ${recorded} verdicts replayed, ${store.observations().length} of them the model's own\n`);
const result = learn(store);
console.log(`  ${describeLearn(result)}\n`);

// What the next pass would settle for free, and how much of it would be right.
const key = (listId, sender) =>
  listId !== null && listId !== undefined && listId !== ''
    ? `list:${listId.toLowerCase()}`
    : `from:${sender}`;
const patterns = new Map(
  result.patterns.map((p) => [key(p.listId, (p.sender ?? '').toLowerCase()), p]),
);

let covered = 0;
let agreeing = 0;
const missed = new Map();
for (const v of verdicts) {
  const m = byN.get(v.n);
  if (m === undefined) continue;
  const hit = patterns.get(key(m.listId, addrOf(m.from)));
  if (hit === undefined) {
    const k = key(m.listId, addrOf(m.from));
    missed.set(k, (missed.get(k) ?? 0) + 1);
    continue;
  }
  covered += 1;
  if (hit.category === v.category) agreeing += 1;
}

const pct = (n) => `${String(Math.round((n / recorded) * 100)).padStart(3)}%`;
console.log(`  a second pass over the same mail`);
console.log(`  settled by a learned pattern   ${String(covered).padStart(4)}  ${pct(covered)}`);
console.log(`  agreeing with the first pass   ${String(agreeing).padStart(4)}  ${pct(agreeing)}`);
console.log(`  still reaching the model       ${String(recorded - covered).padStart(4)}  ${pct(recorded - covered)}`);

console.log(`\n  the ten patterns that would carry the most`);
const weight = new Map();
for (const v of verdicts) {
  const m = byN.get(v.n);
  if (m === undefined) continue;
  const k = key(m.listId, addrOf(m.from));
  if (patterns.has(k)) weight.set(k, (weight.get(k) ?? 0) + 1);
}
for (const [k, n] of [...weight.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(n).padStart(3)}  ${k.slice(0, 52).padEnd(52)}  ${patterns.get(k)?.category}`);
}

// A source seen once can never become a pattern, and that is the ceiling.
const once = [...missed.values()].filter((n) => n === 1).length;
console.log(`\n  sources seen once, which no amount of learning reaches: ${once}`);
store.close();
