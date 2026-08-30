// What the cascade settles once it has been running for a while.
//
// Every measurement so far isolated one node against a cold store. This runs
// the whole thing the way the agent would: messages in the order they arrived,
// threads accumulating as they are decided, patterns re-derived as evidence
// builds. The composition at the end is the architecture's cost argument,
// measured rather than projected.
//
//   node scripts/simulate-agent.mjs [--limit 1000] [--relearn 100]
//
// Chronological and forward-only. Nothing here may consult a decision the real
// agent would not have had yet.
//
// Read-only against the mailbox; every model call goes to the sovereign
// gateway.

import { JmapAdapter } from '../packages/dsh-mail-core/dist/adapters/jmap-adapter.js';
import { runCascade } from '../packages/dsh-mail-core/dist/cascade/cascade-loop.js';
import { createLlmClassifier } from '../packages/dsh-mail-core/dist/cascade/llm-classifier.js';
import { learnPatterns } from '../packages/dsh-mail-core/dist/cascade/learned-patterns.js';
import { MailStore } from '../packages/dsh-mail-core/dist/store/mail-store.js';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return Number(i === -1 ? d : args[i + 1]);
};
const LIMIT = flag('limit', 1000);
const RELEARN = flag('relearn', 100);

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

// --- fetch, oldest first ----------------------------------------------------

const boxes = await jmap([['Mailbox/get', { accountId: ACC, ids: null }, 'c']]);
const inbox = boxes.methodResponses[0][1].list.find((m) => m.role === 'inbox');

// James caps a response at 256 ids whatever `limit` says. Stop when a page is
// empty, not when it is short.
const ids = [];
while (ids.length < LIMIT) {
  const page = await jmap([
    ['Email/query', {
      accountId: ACC,
      filter: { inMailbox: inbox.id },
      sort: [{ property: 'receivedAt', isAscending: true }],
      position: ids.length,
      limit: Math.min(500, LIMIT - ids.length),
    }, 'q'],
  ]);
  const got = page.methodResponses[0][1].ids;
  if (got.length === 0) break;
  ids.push(...got);
}

const messages = await adapter.getMessages(ids);
const span = new Set(messages.map((m) => m.receivedAt.toISOString().slice(0, 10))).size;
console.log(`${messages.length} messages over ${span} day(s), oldest first`);
console.log(`patterns re-derived every ${RELEARN} messages\n`);

// --- run --------------------------------------------------------------------

const store = new MailStore(':memory:');
const observations = [];
const byNode = new Map();
const byCategory = new Map();
let classified = 0;
let failed = 0;
const started = Date.now();

// The rate over the last slice, so a number that improves as the store warms
// is visible as it happens rather than only in the average.
let sliceStart = 0;
let sliceModelCalls = 0;

for (const [index, message] of messages.entries()) {
  const context = {
    owner: process.env.MAIL_SENTINEL_OWNER ?? 'mmaudet@linagora.com',
    vipSenders: [],
    corporateDomains: ['linagora.com'],
    threadCategory: store.threadCategory(message.threadId),
    learnedPatterns: store.loadPatterns(),
  };

  try {
    const trace = await runCascade(message, { context, model });
    // PRD 4.2 gates node 1 on the owner having acted in the thread. `$answered`
    // is the server's record of exactly that, and it is the one signal in this
    // design that reuse cannot inflate.
    const ownerActed = message.keywords.some((k) => k.toLowerCase() === '$answered');
    store.recordTrace(trace, message.threadId, ownerActed);
    observations.push({
      sender: message.from[0]?.email ?? '',
      listId: message.listId,
      category: trace.category,
      confidence: trace.confidence,
      decidedBy: trace.decidedBy,
    });
    byNode.set(trace.decidedBy, (byNode.get(trace.decidedBy) ?? 0) + 1);
    byCategory.set(trace.category, (byCategory.get(trace.category) ?? 0) + 1);
    classified += 1;
  } catch {
    failed += 1;
  }

  if ((index + 1) % RELEARN === 0) {
    store.savePatterns(learnPatterns(observations));
    const done = index + 1 - sliceStart;
    const calls = modelCalls - sliceModelCalls;
    const free = done === 0 ? 0 : ((done - calls) / done) * 100;
    console.log(
      `  after ${String(index + 1).padStart(4)}: ${free.toFixed(0)}% free in the last ${done}` +
        `  (${store.loadPatterns().length} patterns)`,
    );
    sliceStart = index + 1;
    sliceModelCalls = modelCalls;
  }
}

const free = classified === 0 ? 0 : ((classified - modelCalls) / classified) * 100;
console.log(`\n--- settled by ---`);
for (const [node, n] of [...byNode].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${((n / classified) * 100).toFixed(0).padStart(3)}%  ${node}`);
}
console.log(`\n--- by category ---`);
for (const [c, n] of [...byCategory].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${c}`);
}
console.log(`\n--- the cost argument ---`);
console.log(`  classified   : ${classified}${failed ? ` (${failed} failed)` : ''}`);
console.log(`  model calls  : ${modelCalls}`);
console.log(`  settled free : ${free.toFixed(0)}%`);
console.log(`  wall clock   : ${((Date.now() - started) / 60000).toFixed(1)} min`);
store.close();
console.log('\nRead-only against the mailbox. Nothing was written.');
