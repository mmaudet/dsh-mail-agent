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
  category: trace.category,
  confidence: trace.confidence,
  decidedBy: trace.decidedBy,
}));
const patterns = learnPatterns(observations);
console.log(`\n${patterns.length} pattern(s) learned from ${observations.length} decisions:`);
for (const p of patterns.slice(0, 12)) {
  console.log(`  ${p.category.padEnd(24)} ${p.sender}  (${p.confidence.toFixed(2)})`);
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
