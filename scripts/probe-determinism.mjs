// Is temperature 0 actually deterministic on this gateway?
//
// The pattern measurement saw five classifications change between two passes
// over identical messages, while only two learned patterns fired. The other
// three had nothing to explain them but the model itself.
//
// It matters beyond curiosity: every calibration, every A/B comparison and
// every "the same message classifies the same way twice" assumption in this
// project rests on it.
//
//   node scripts/probe-determinism.mjs [--messages 12] [--repeats 3]

import { JmapAdapter } from '../packages/dsh-mail-core/dist/adapters/jmap-adapter.js';
import { createLlmClassifier } from '../packages/dsh-mail-core/dist/cascade/llm-classifier.js';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return Number(i === -1 ? d : args[i + 1]);
};
const COUNT = flag('messages', 12);
const REPEATS = flag('repeats', 3);

const API_BASE = process.env.MAIL_SENTINEL_API_BASE;
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
    limit: COUNT,
  }, 'q'],
]);
const messages = await adapter.getMessages(q.methodResponses[0][1].ids);

console.log(`${messages.length} messages, ${REPEATS} passes each, temperature 0\n`);

let unstableCategory = 0;
let unstableConfidence = 0;

for (const m of messages) {
  const answers = [];
  for (let i = 0; i < REPEATS; i += 1) {
    try {
      answers.push(await model.classify(m, context));
    } catch (e) {
      answers.push({ category: `ERROR:${String(e.message).slice(0, 20)}`, confidence: -1 });
    }
  }
  const categories = new Set(answers.map((a) => a.category));
  const confidences = new Set(answers.map((a) => a.confidence));
  if (categories.size > 1) unstableCategory += 1;
  if (confidences.size > 1) unstableConfidence += 1;

  const mark = categories.size > 1 ? '!!' : confidences.size > 1 ? ' ~' : '  ';
  console.log(
    `${mark} ${[...categories].join(' / ').padEnd(40)} conf ${[...confidences].join('/')}  ${(m.subject || '').slice(0, 36)}`,
  );
}

console.log(`\n  category unstable   : ${unstableCategory} of ${messages.length}`);
console.log(`  confidence unstable : ${unstableConfidence} of ${messages.length}`);
console.log('\n!! = the category itself changed between identical requests.');
