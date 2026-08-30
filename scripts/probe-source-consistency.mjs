// Does the classifier give one answer per source, or several?
//
// The holdout runs blamed the window, then the granularity. The diagnostic said
// otherwise: of seven frequent sources that yielded no learned pattern, six
// failed because the model disagreed with itself — one support address came
// back under four categories across seven messages.
//
// That is the binding constraint, and it is measurable on its own. A cascade
// cannot cache an answer that is not stable enough to cache.
//
//   node scripts/probe-source-consistency.mjs [--limit 200] [--min 3]
//
// Read-only, and every model call goes to the sovereign gateway.

import { JmapAdapter } from '../packages/dsh-mail-core/dist/adapters/jmap-adapter.js';
import { createLlmClassifier } from '../packages/dsh-mail-core/dist/cascade/llm-classifier.js';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return Number(i === -1 ? d : args[i + 1]);
};
const LIMIT = flag('limit', 200);
const MIN = flag('min', 3);

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

const llm = {
  async *stream(options) {
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
const context = {
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
    sort: [{ property: 'receivedAt', isAscending: false }],
    limit: LIMIT,
  }, 'q'],
]);
const messages = await adapter.getMessages(q.methodResponses[0][1].ids);

const bySource = new Map();
for (const m of messages) {
  const key = m.listId ? `list:${m.listId}` : `from:${(m.from[0]?.email ?? '').toLowerCase()}`;
  const bucket = bySource.get(key) ?? [];
  bucket.push(m);
  bySource.set(key, bucket);
}

const frequent = [...bySource.entries()]
  .filter(([, ms]) => ms.length >= MIN)
  .sort((a, b) => b[1].length - a[1].length);

console.log(`${messages.length} messages, ${frequent.length} source(s) seen ${MIN}+ times\n`);

let unanimous = 0;
let coveredByUnanimous = 0;
let classified = 0;

for (const [key, ms] of frequent) {
  const categories = new Map();
  for (const m of ms) {
    try {
      const v = await model.classify(m, context);
      categories.set(v.category, (categories.get(v.category) ?? 0) + 1);
      classified += 1;
    } catch {
      /* a malformed answer is not what this measures */
    }
  }
  const spread = [...categories.entries()].sort((a, b) => b[1] - a[1]);
  const agrees = spread.length === 1;
  if (agrees) {
    unanimous += 1;
    coveredByUnanimous += ms.length;
  }
  console.log(
    `${agrees ? ' ok ' : 'SPLIT'} ${String(ms.length).padStart(3)}  ${key.slice(0, 46).padEnd(46)} ${spread.map(([c, n]) => `${c}×${String(n)}`).join(' ')}`,
  );
}

const total = frequent.reduce((n, [, ms]) => n + ms.length, 0);
console.log(`\n  unanimous sources      : ${unanimous} of ${frequent.length}`);
console.log(`  messages they cover    : ${coveredByUnanimous} of ${messages.length} (${((coveredByUnanimous / messages.length) * 100).toFixed(0)}%)`);
console.log(`  ↑ what node 3 could actually learn, against a ceiling of ${((total / messages.length) * 100).toFixed(0)}%`);
console.log(`\n  ${classified} model calls. Read-only throughout.`);
