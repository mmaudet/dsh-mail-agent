// Compare two dry runs of the same cascade over the same messages.
//
//   node scripts/compare-runs.mjs --a /tmp/dry-run-mistral.json --b /tmp/dry-run-qwen.json
//
// The point is not which model scores higher against the large one that derived
// the vocabulary — that is agreement with a third opinion, not accuracy. It is
// whether the two cheap models fail in the *same* places. Two models that
// disagree with the reference on the same messages have found something hard;
// two that disagree on different messages have found nothing, and the reference
// is the thing being measured.
//
// Reads only files. No model call, no mailbox.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const load = (path) => {
  const rows = JSON.parse(readFileSync(path, 'utf8')).filter((r) => r.category);
  return new Map(rows.map((r) => [r.n, r]));
};
const A = load(arg('a', '/tmp/dry-run-mistral.json'));
const B = load(arg('b', '/tmp/dry-run-qwen.json'));
const nameA = arg('name-a', 'A');
const nameB = arg('name-b', 'B');

// The vocabulary was renamed after the reference was written; folding it here
// keeps a rename from reading as a disagreement.
const canon = (c) => (c === 'liste-diffusion-licence-open-source' ? 'liste-diffusion' : c);

const shared = [...A.keys()].filter((n) => B.has(n));
const scored = shared.filter((n) => {
  const ref = A.get(n).reference;
  return ref !== null && ref !== 'autre';
});

const hit = (m, n) => canon(m.get(n).category) === canon(m.get(n).reference);
const aHit = scored.filter((n) => hit(A, n));
const bHit = scored.filter((n) => hit(B, n));
const pct = (k) => `${Math.round((k / scored.length) * 100)}%`;

console.log(`  ${shared.length} messages in both runs, ${scored.length} with a reference\n`);
console.log(`  agreement with the model that derived the vocabulary`);
console.log(`  ${nameA.padEnd(28)} ${String(aHit.length).padStart(4)}  ${pct(aHit.length)}`);
console.log(`  ${nameB.padEnd(28)} ${String(bHit.length).padStart(4)}  ${pct(bHit.length)}`);

// The question this script exists for.
const bothRight = scored.filter((n) => hit(A, n) && hit(B, n)).length;
const bothWrong = scored.filter((n) => !hit(A, n) && !hit(B, n));
const onlyA = scored.filter((n) => hit(A, n) && !hit(B, n)).length;
const onlyB = scored.filter((n) => !hit(A, n) && hit(B, n)).length;
console.log(`\n  where they land`);
console.log(`  both agree with the reference   ${String(bothRight).padStart(4)}  ${pct(bothRight)}`);
console.log(`  only ${nameA.padEnd(22)}    ${String(onlyA).padStart(4)}  ${pct(onlyA)}`);
console.log(`  only ${nameB.padEnd(22)}    ${String(onlyB).padStart(4)}  ${pct(onlyB)}`);
console.log(`  neither                         ${String(bothWrong.length).padStart(4)}  ${pct(bothWrong.length)}`);

const agreeWithEachOther = shared.filter((n) => canon(A.get(n).category) === canon(B.get(n).category)).length;
console.log(`\n  the two cheap models agree with each other on ${agreeWithEachOther}/${shared.length} (${Math.round((agreeWithEachOther / shared.length) * 100)}%)`);

// A message both models miss is a hard message; a message both miss the same
// way is a message the reference may have got wrong.
const sameMiss = bothWrong.filter((n) => canon(A.get(n).category) === canon(B.get(n).category));
console.log(`  of the ${bothWrong.length} neither got, they gave the same answer on ${sameMiss.length}`);
if (sameMiss.length > 0) {
  const c = {};
  for (const n of sameMiss) {
    const k = `${canon(A.get(n).reference)} -> ${canon(A.get(n).category)}`;
    c[k] = (c[k] ?? 0) + 1;
  }
  console.log('\n  both cheap models said the same thing, and it was not the reference');
  console.log('  (the shortlist for the reference itself being wrong)');
  for (const [k, n] of Object.entries(c).sort((x, y) => y[1] - x[1]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(4)}  ${k}`);
  }
}

// The rule that removes mail.
const trashed = (m) => shared.filter((n) => (m.get(n).auto ?? []).includes('trash'));
const tA = trashed(A);
const tB = trashed(B);
const both = tA.filter((n) => tB.includes(n));
console.log(`\n  what each would trash unattended`);
console.log(`  ${nameA.padEnd(28)} ${String(tA.length).padStart(4)}  ${Math.round((tA.length / shared.length) * 100)}%`);
console.log(`  ${nameB.padEnd(28)} ${String(tB.length).padStart(4)}  ${Math.round((tB.length / shared.length) * 100)}%`);
console.log(`  both would trash             ${String(both.length).padStart(4)}`);
console.log(`  only one would               ${String(tA.length + tB.length - 2 * both.length).padStart(4)}  <- deleted or kept by which model is deployed`);

// The cheap nodes are the same code in both runs, so any difference is the
// model's answer changing which node got there first.
const free = (m) => shared.filter((n) => m.get(n).decidedBy !== 'llm' && m.get(n).decidedBy !== 'below-threshold').length;
const unsure = (m) => shared.filter((n) => m.get(n).category === 'needs-review').length;
console.log(`\n  settled without a model call   ${nameA}: ${free(A)}   ${nameB}: ${free(B)}`);
console.log(`  answered needs-review          ${nameA}: ${unsure(A)}   ${nameB}: ${unsure(B)}`);
