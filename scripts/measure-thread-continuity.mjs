// Does node 1 pay, on a mailbox that is mostly written by people?
//
// The consistency measurement said learned patterns top out around 19%,
// because a source with several purposes has several categories and most
// sources have several purposes. Node 1 does not reason about sources at all:
// a reply in a thread already decided inherits that decision.
//
//   node scripts/measure-thread-continuity.mjs [--limit 200]
//
// Chronological, oldest first, exactly as a poll would meet them — because a
// thread can only be inherited from after it has been decided, and any other
// ordering measures a future the agent will not have.
//
// Read-only, and every model call goes to the sovereign gateway.

import { JmapAdapter } from '../packages/dsh-mail-core/dist/adapters/jmap-adapter.js';
import { runCascade } from '../packages/dsh-mail-core/dist/cascade/cascade-loop.js';
import { createLlmClassifier } from '../packages/dsh-mail-core/dist/cascade/llm-classifier.js';
import { MailStore } from '../packages/dsh-mail-core/dist/store/mail-store.js';

const args = process.argv.slice(2);
const li = args.indexOf('--limit');
const LIMIT = Number(li === -1 ? 200 : args[li + 1]);

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

const folders = await adapter.listFolders();
const inbox = folders.find((f) => f.role === 'inbox');
const q = await jmap([
  ['Email/query', {
    accountId: ACC,
    filter: { inMailbox: inbox.id },
    sort: [{ property: 'receivedAt', isAscending: true }],
    limit: LIMIT,
  }, 'q'],
]);
const messages = await adapter.getMessages(q.methodResponses[0][1].ids);

const threaded = messages.filter((m) => m.threadId !== null).length;
console.log(`${messages.length} messages, oldest first`);
console.log(`${threaded} carry a threadId (${((threaded / messages.length) * 100).toFixed(0)}%)\n`);

async function pass(useThreads, label) {
  // A fresh store each pass: node 1 must inherit only from this run.
  const store = new MailStore(':memory:');
  modelCalls = 0;
  const byNode = new Map();
  let classified = 0;

  for (const message of messages) {
    const threadCategory = useThreads ? store.threadCategory(message.threadId) : null;
    try {
      const trace = await runCascade(message, {
        context: { ...baseContext, threadCategory },
        model,
      });
      store.recordTrace(trace, message.threadId);
      byNode.set(trace.decidedBy, (byNode.get(trace.decidedBy) ?? 0) + 1);
      classified += 1;
    } catch {
      /* a malformed answer is not what this measures */
    }
  }

  const free = classified === 0 ? 0 : ((classified - modelCalls) / classified) * 100;
  console.log(`${label}: ${classified} classified, ${modelCalls} model calls, ${free.toFixed(0)}% free`);
  console.log(`  ${[...byNode].map(([k, v]) => `${k}=${v}`).join('  ')}`);
  store.close();
  return { free, classified, modelCalls };
}

const without = await pass(false, 'without node 1');
const with_ = await pass(true, 'with node 1   ');

console.log(`\n  ${(with_.free - without.free).toFixed(0)} percentage points`);
console.log(`  ${without.modelCalls - with_.modelCalls} fewer model calls out of ${without.modelCalls}`);
console.log('\nRead-only throughout.');
