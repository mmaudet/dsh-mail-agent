// Classify a slice of a real mailbox and report what it cost. Writes nothing.
//
// This is the Phase 2 output PRD section 6 asks for: "batch classifier une
// mailbox réelle (dry-run, aucune écriture)". It answers the one number the
// architecture rests on and that no synthetic corpus can settle — how much of a
// real inbox the cheap nodes settle without a model call.
//
//   node scripts/dry-run-classify.mjs [--limit 30] [--folder INBOX]
//
// Reaches past `MailService` on purpose: the contract has no way to enumerate
// an existing mailbox. `getMessages` needs ids and nothing produces them for
// mail that is already there, so this uses `Email/query` directly. That gap is
// recorded in docs/adapters.md; closing it is a contract decision, not a
// script's to make.
//
// Every model call goes to the sovereign gateway. The route is asserted before
// anything is sent, because a benchmark route left in a profile would put real
// mail through a third party.

import { JmapAdapter } from '../packages/dsh-mail-core/dist/adapters/jmap-adapter.js';
import { runCascade } from '../packages/dsh-mail-core/dist/cascade/cascade-loop.js';
import { createLlmClassifier } from '../packages/dsh-mail-core/dist/cascade/llm-classifier.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const LIMIT = Number(flag('limit', '30'));
const FOLDER = flag('folder', 'INBOX');

const SESSION_URL = process.env.MAIL_SENTINEL_JMAP_SESSION_URL;
const ACCOUNT_ID = process.env.MAIL_SENTINEL_JMAP_ACCOUNT_ID;
const TOKENS = process.env.MAIL_SENTINEL_JMAP_TOKENS;
const API_BASE = process.env.MAIL_SENTINEL_API_BASE;
const API_KEY = process.env.MAIL_SENTINEL_API_KEY;
const OWNER = process.env.MAIL_SENTINEL_OWNER ?? 'mmaudet@linagora.com';

for (const [name, value] of Object.entries({
  MAIL_SENTINEL_JMAP_SESSION_URL: SESSION_URL,
  MAIL_SENTINEL_JMAP_ACCOUNT_ID: ACCOUNT_ID,
  MAIL_SENTINEL_JMAP_TOKENS: TOKENS,
  MAIL_SENTINEL_API_BASE: API_BASE,
  MAIL_SENTINEL_API_KEY: API_KEY,
})) {
  if (!value) {
    console.error(`${name} is not set`);
    process.exit(2);
  }
}

// The perimeter check, before a single byte of mail is rendered into a prompt.
if (!/^https:\/\/chat\.lucie\.ovh\.linagora\.com\//.test(API_BASE)) {
  console.error(`Refusing to run: MAIL_SENTINEL_API_BASE is ${API_BASE}`);
  console.error('Real mail content only goes to the sovereign gateway.');
  process.exit(2);
}

const bearer = JSON.parse(TOKENS).accessToken;

// --- JMAP -------------------------------------------------------------------

let apiUrl = null;
async function jmap(using, methodCalls) {
  if (apiUrl === null) {
    const session = await fetch(SESSION_URL, {
      headers: { accept: 'application/json', authorization: `Bearer ${bearer}` },
    });
    if (!session.ok) throw new Error(`session ${session.status} (token expired? run mail-auth refresh)`);
    apiUrl = (await session.json()).apiUrl;
  }
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      using,
      methodCalls,
    }),
  });
  if (!response.ok) throw new Error(`JMAP ${response.status}`);
  return response.json();
}

/** Unwrapped, for this script's own calls. The adapter wants the whole body. */
async function jmapOne(methodCalls) {
  const body = await jmap(['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls);
  const [name, value] = body.methodResponses[0];
  if (name === 'error') throw new Error(`JMAP error: ${value.type}`);
  return value;
}

const transport = { request: (body) => jmap(body.using, body.methodCalls) };
const adapter = new JmapAdapter({ transport, accountId: ACCOUNT_ID, identityId: 'unused' });

// --- the sovereign classifier ----------------------------------------------

/** Minimal OpenAI-compatible streamer, so the script needs no harness boot. */
const llm = {
  async *stream(options) {
    const response = await fetch(`${API_BASE.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: options.model,
        temperature: options.temperature ?? 0,
        max_tokens: options.maxTokens ?? 256,
        messages: [
          { role: 'system', content: options.system },
          {
            role: 'user',
            content: options.messages[0].content.map((b) => b.text).join(''),
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`gateway ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const body = await response.json();
    yield { type: 'text-delta', index: 0, text: body.choices?.[0]?.message?.content ?? '' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};

const model = createLlmClassifier({
  llm,
  provider: 'mail-llm-economy',
  model: process.env.MAIL_SENTINEL_ECONOMY_MODEL ?? 'Mistral-Small-3.2-24B-Instruct-2506-FP8',
});

const context = {
  owner: OWNER,
  vipSenders: (process.env.MAIL_SENTINEL_VIP ?? '').split(',').filter(Boolean),
  corporateDomains: (process.env.MAIL_SENTINEL_CORPORATE ?? 'linagora.com').split(',').filter(Boolean),
  threadCategory: null,
  learnedPatterns: [],
};

// --- run --------------------------------------------------------------------

console.log(`folder ${FOLDER}, limit ${LIMIT}, gateway ${API_BASE}`);
console.log(`owner ${OWNER}, corporate ${context.corporateDomains.join(',') || '(none)'}\n`);

const folders = await adapter.listFolders();
const target = folders.find((f) => f.path === FOLDER || f.role === FOLDER.toLowerCase());
if (!target) {
  console.error(`No such folder: ${FOLDER}. Have: ${folders.slice(0, 8).map((f) => f.path).join(', ')}…`);
  process.exit(2);
}

// The enumeration the contract cannot do.
const query = await jmapOne([
  ['Email/query', {
    accountId: ACCOUNT_ID,
    filter: { inMailbox: target.id },
    sort: [{ property: 'receivedAt', isAscending: false }],
    limit: LIMIT,
  }, 'q0'],
]);
const ids = query.ids ?? [];
console.log(`${ids.length} message(s) to classify\n`);

const messages = await adapter.getMessages(ids);

const byCategory = new Map();
const byNode = new Map();
let modelCalls = 0;
let failures = 0;
const started = Date.now();

for (const message of messages) {
  let trace;
  try {
    trace = await runCascade(message, { context, model });
  } catch (err) {
    failures += 1;
    console.log(`  !  ${String(err.message).slice(0, 90)}`);
    continue;
  }
  byCategory.set(trace.category, (byCategory.get(trace.category) ?? 0) + 1);
  byNode.set(trace.decidedBy, (byNode.get(trace.decidedBy) ?? 0) + 1);
  if (trace.usedModel) modelCalls += 1;

  const subject = (message.subject || '(no subject)').slice(0, 46).padEnd(46);
  const mark = trace.usedModel ? '$' : ' ';
  console.log(
    `${mark} ${trace.category.padEnd(24)} ${trace.decidedBy.padEnd(18)} ${subject} ${trace.confidence.toFixed(2)}`,
  );
}

const done = messages.length - failures;
console.log('\n--- by category ---');
for (const [k, v] of [...byCategory].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
}
console.log('--- by deciding node ---');
for (const [k, v] of [...byNode].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
}
console.log('\n--- the number the architecture rests on ---');
console.log(`  classified   : ${done}${failures ? ` (${failures} failed)` : ''}`);
console.log(`  model calls  : ${modelCalls}`);
console.log(
  `  settled free : ${done === 0 ? 'n/a' : `${(((done - modelCalls) / done) * 100).toFixed(0)}%`}`,
);
console.log(`  wall clock   : ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log('\nNothing was written. Read-only throughout.');
