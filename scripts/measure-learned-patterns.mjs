// Does node 3 recover the efficiency the cascade gave up?
//
// The first dry run measured 10% settled without a model call, with node 3
// empty. The PRD's bet is that a mailbox is mostly the same senders, so
// classifying each once and remembering the answer is where the saving comes
// from. This measures the bet.
//
//   node scripts/measure-learned-patterns.mjs [--learn 100] [--test 100]
//
// Two disjoint slices, because learning and measuring on the same messages
// would be circular: patterns derived from a message settle that message by
// construction. The older slice teaches, the newer slice is the holdout.
//
// Read-only. Every model call goes to the sovereign gateway.

import { JmapAdapter } from '../packages/dsh-mail-core/dist/adapters/jmap-adapter.js';
import { runCascade } from '../packages/dsh-mail-core/dist/cascade/cascade-loop.js';
import { createLlmClassifier } from '../packages/dsh-mail-core/dist/cascade/llm-classifier.js';
import { learnPatterns } from '../packages/dsh-mail-core/dist/cascade/learned-patterns.js';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return Number(i === -1 ? d : args[i + 1]);
};
const LEARN = flag('learn', 100);
const TEST = flag('test', 100);

const API_BASE = process.env.MAIL_SENTINEL_API_BASE;
if (!/^https:\/\/chat\.lucie\.ovh\.linagora\.com\//.test(API_BASE ?? '')) {
  console.error(`Refusing to run: MAIL_SENTINEL_API_BASE is ${API_BASE}`);
  process.exit(2);
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
  identityId: 'unused',
});

let modelCalls = 0;
const llm = {
  async *stream(options) {
    modelCalls += 1;
    const r = await fetch(`${API_BASE.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.MAIL_SENTINEL_API_KEY}`,
      },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        max_tokens: options.maxTokens ?? 256,
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.messages[0].content.map((b) => b.text).join('') },
        ],
      }),
    });
    if (!r.ok) throw new Error(`gateway ${r.status}`);
    const body = await r.json();
    yield { type: 'text-delta', index: 0, text: body.choices?.[0]?.message?.content ?? '' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};

const model = createLlmClassifier({
  llm,
  provider: 'mail-llm-economy',
  model: 'Mistral-Small-3.2-24B-Instruct-2506-FP8',
});

const baseContext = {
  owner: process.env.MAIL_SENTINEL_OWNER ?? 'mmaudet@linagora.com',
  vipSenders: [],
  corporateDomains: ['linagora.com'],
  threadCategory: null,
  learnedPatterns: [],
};

// --- fetch two disjoint slices, newest first --------------------------------

const folders = await adapter.listFolders();
const inbox = folders.find((f) => f.role === 'inbox');
const q = await jmap([
  ['Email/query', {
    accountId: ACC,
    filter: { inMailbox: inbox.id },
    sort: [{ property: 'receivedAt', isAscending: false }],
    limit: LEARN + TEST,
  }, 'q'],
]);
const ids = q.methodResponses[0][1].ids;
const all = await adapter.getMessages(ids);

// Newest is the holdout: patterns must predict forward, not backward.
const test = all.slice(0, TEST);
const learn = all.slice(TEST, TEST + LEARN);

// A folder holds what it holds. Asking for 400 and silently measuring 56 is
// how a run reports a number for an experiment nobody designed.
if (learn.length < LEARN || test.length < TEST) {
  console.error(
    `Asked for ${LEARN} to learn and ${TEST} to test; the folder holds ${all.length}, ` +
      `which gives ${learn.length} and ${test.length}.`,
  );
  console.error('Lower --learn/--test, or point at a folder with more in it.');
  process.exit(2);
}
console.log(`learn on ${learn.length} older messages, measure on ${test.length} newer\n`);

async function pass(messages, context, label) {
  modelCalls = 0;
  const traces = [];
  const byNode = new Map();
  for (const m of messages) {
    try {
      const t = await runCascade(m, { context, model });
      traces.push({ message: m, trace: t });
      byNode.set(t.decidedBy, (byNode.get(t.decidedBy) ?? 0) + 1);
    } catch {
      /* a malformed answer is not what this measures */
    }
  }
  const free = traces.length === 0 ? 0 : ((traces.length - modelCalls) / traces.length) * 100;
  console.log(`${label}: ${traces.length} classified, ${modelCalls} model calls, ${free.toFixed(0)}% free`);
  console.log(`  ${[...byNode].map(([k, v]) => `${k}=${v}`).join('  ')}`);
  return traces;
}

// --- teach ------------------------------------------------------------------

const taught = await pass(learn, baseContext, 'learning pass ');

const observations = taught.map(({ message, trace }) => ({
  sender: message.from[0]?.email ?? '',
  listId: message.listId,
  category: trace.category,
  confidence: trace.confidence,
  decidedBy: trace.decidedBy,
}));
const patterns = learnPatterns(observations);

// Why the frequent sources that did *not* become patterns did not. Without
// this the run reports a number and no way to act on it.
const bySource = new Map();
for (const o of observations) {
  const key = o.listId ? `list:${o.listId}` : `from:${(o.sender || '').toLowerCase()}`;
  const b = bySource.get(key) ?? { n: 0, categories: new Set(), lowConfidence: 0, cheap: 0 };
  b.n += 1;
  b.categories.add(o.category);
  if (o.decidedBy !== 'llm') b.cheap += 1;
  else if (o.confidence < 0.85) b.lowConfidence += 1;
  bySource.set(key, b);
}
const rejected = [...bySource.entries()]
  .filter(([, b]) => b.n >= 3)
  .filter(([key]) => !patterns.some((p) => key === (p.listId ? `list:${p.listId}` : `from:${p.sender}`)))
  .sort((a, b) => b[1].n - a[1].n);

if (rejected.length > 0) {
  console.log(`\n${rejected.length} frequent source(s) yielded no pattern:`);
  for (const [key, b] of rejected.slice(0, 10)) {
    const why =
      b.categories.size > 1
        ? `disagreed: ${[...b.categories].join('/')}`
        : b.cheap > 0
          ? `${b.cheap} decided by a cheaper node`
          : b.lowConfidence > 0
            ? `${b.lowConfidence} below the confidence floor`
            : 'fewer than 3 usable observations';
    console.log(`  ${String(b.n).padStart(3)}  ${key.slice(0, 52).padEnd(52)} ${why}`);
  }
}

console.log(`\n${patterns.length} pattern(s) learned from ${observations.length} decisions:`);
for (const p of patterns.slice(0, 12)) {
  const key = p.listId ? `list:${p.listId}` : p.sender;
  console.log(`  ${p.category.padEnd(24)} ${key}  (${p.confidence.toFixed(2)})`);
}
if (patterns.length > 12) console.log(`  … and ${patterns.length - 12} more`);
console.log();

// --- measure ----------------------------------------------------------------

const before = await pass(test, baseContext, 'holdout, no patterns');
const after = await pass(test, { ...baseContext, learnedPatterns: patterns }, 'holdout, patterns  ');

// Where the two disagree is the cost of trusting a pattern.
let changed = 0;
for (let i = 0; i < Math.min(before.length, after.length); i += 1) {
  if (before[i].trace.category !== after[i].trace.category) {
    changed += 1;
    if (changed <= 8) {
      console.log(
        `  changed: ${before[i].trace.category} -> ${after[i].trace.category}  ${(before[i].message.subject || '').slice(0, 44)}`,
      );
    }
  }
}
console.log(`\n${changed} of ${before.length} classifications changed under the patterns.`);
console.log('Nothing was written. Read-only throughout.');
