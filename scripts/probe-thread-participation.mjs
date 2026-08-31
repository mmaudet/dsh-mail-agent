// Does the owner's own position in a thread separate important from standard?
//
// The calibration against thirty human labels showed the prompt cannot be the
// lever: rewriting its first rule moved the threshold and left the number of
// boundary errors at fourteen either way. The rule it now asks — "an action
// only the owner can take, that has not been taken" — is unanswerable from
// what the node is shown, because whether the owner already acted lives in the
// thread and the node only ever sees one message.
//
// Before wiring thread state into `renderMessage`, measure whether it carries
// anything. The last hypothesis this project tested before building — that
// recipient position was the missing signal — turned out inverted, and one
// probe cost less than a release.
//
//   node scripts/probe-thread-participation.mjs
//
// Reads only. No model call: this asks whether a feature separates the labels,
// which needs no classifier.

import { readFileSync } from 'node:fs';

const LABELS = JSON.parse(readFileSync('/tmp/human-labels.json', 'utf8'));
const PINNED = JSON.parse(readFileSync('/tmp/label-predictions.json', 'utf8'));
const OWNER = (process.env.MAIL_SENTINEL_OWNER ?? 'mmaudet@linagora.com').toLowerCase();

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
  const body = await r.json();
  const err = body.methodResponses?.find((m) => m[0] === 'error');
  if (err) throw new Error(JSON.stringify(err[1]));
  return body;
}

const ids = PINNED.map((p) => p.id);
const heads = (await jmap([['Email/get', {
  accountId: ACC, ids, properties: ['id', 'threadId', 'subject', 'receivedAt', 'from'],
}, 'g']])).methodResponses[0][1].list;
const headById = new Map(heads.map((m) => [m.id, m]));

// One Thread/get for the lot, then one Email/get per thread's members.
const threadIds = [...new Set(heads.map((m) => m.threadId))];
const threads = (await jmap([['Thread/get', { accountId: ACC, ids: threadIds }, 't']]))
  .methodResponses[0][1].list;
const threadById = new Map(threads.map((t) => [t.id, t]));

const memberIds = [...new Set(threads.flatMap((t) => t.emailIds))];
const members = [];
for (let i = 0; i < memberIds.length; i += 50) {
  const chunk = memberIds.slice(i, i + 50);
  members.push(...(await jmap([['Email/get', {
    accountId: ACC, ids: chunk, properties: ['id', 'threadId', 'from', 'receivedAt'],
  }, 'm']])).methodResponses[0][1].list);
}
const byThread = new Map();
for (const m of members) {
  if (!byThread.has(m.threadId)) byThread.set(m.threadId, []);
  byThread.get(m.threadId).push(m);
}

const rows = [];
for (const pin of PINNED) {
  const truth = LABELS[String(pin.n)];
  const head = headById.get(pin.id);
  if (!truth || !head) continue;
  const thread = byThread.get(head.threadId) ?? [];
  const ownerWrote = thread.filter((m) => (m.from ?? []).some(
    (a) => (a.email ?? '').toLowerCase() === OWNER,
  ));
  // Only replies that came before this message count: whether the owner has
  // answered *since* is hindsight the live agent would not have.
  const before = ownerWrote.filter((m) => m.receivedAt < head.receivedAt);
  rows.push({
    n: pin.n,
    truth,
    size: thread.length,
    ownerWroteBefore: before.length,
    subject: (head.subject ?? '').slice(0, 40),
  });
}

const table = (title, predicate) => {
  const cats = [...new Set(rows.map((r) => r.truth))].sort();
  const yes = rows.filter(predicate);
  const no = rows.filter((r) => !predicate(r));
  console.log(`\n  ${title}`);
  console.log(`  ${''.padEnd(16)} ${'yes'.padStart(8)} ${'no'.padStart(8)}`);
  for (const c of cats) {
    const y = yes.filter((r) => r.truth === c).length;
    const n = no.filter((r) => r.truth === c).length;
    const pct = y + n === 0 ? '' : `   ${Math.round((y / (y + n)) * 100)}% yes`;
    console.log(`  ${c.padEnd(16)} ${String(y).padStart(8)} ${String(n).padStart(8)}${pct}`);
  }
  console.log(`  ${'total'.padEnd(16)} ${String(yes.length).padStart(8)} ${String(no.length).padStart(8)}`);
};

console.log(`  ${rows.length} labelled messages, thread state from the server\n`);
for (const r of rows) {
  console.log(
    `  ${String(r.n).padStart(2)}  ${r.truth.padEnd(14)} ` +
      `thread=${String(r.size).padStart(2)}  owner-wrote-before=${r.ownerWroteBefore}  ${r.subject}`,
  );
}

table('owner already wrote in this thread', (r) => r.ownerWroteBefore > 0);
table('thread has more than one message', (r) => r.size > 1);

// The question the calibration left: does either feature separate important
// from standard well enough to be worth showing the model?
const imp = rows.filter((r) => r.truth === 'important');
const std = rows.filter((r) => r.truth === 'standard');
const rate = (set, p) => (set.length === 0 ? 0 : Math.round((set.filter(p).length / set.length) * 100));
console.log('\n  separation');
console.log(`  ${'feature'.padEnd(34)} ${'important'.padStart(10)} ${'standard'.padStart(10)}`);
for (const [name, p] of [
  ['owner wrote in thread before', (r) => r.ownerWroteBefore > 0],
  ['thread longer than one message', (r) => r.size > 1],
  ['thread longer than two messages', (r) => r.size > 2],
]) {
  console.log(`  ${name.padEnd(34)} ${String(rate(imp, p) + '%').padStart(10)} ${String(rate(std, p) + '%').padStart(10)}`);
}
