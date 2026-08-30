// Run the agent over a real mailbox. Writes nothing unless told to.
//
//   node scripts/run-agent.mjs                 # one dry pass
//   node scripts/run-agent.mjs --write         # tags only, under the shipped policy
//   node scripts/run-agent.mjs --every 60      # keep going until interrupted
//
// This is Phase 3's output: the first real run with writes. Under the shipped
// approval policy a real run tags and files nothing — every move and every
// deletion is `ask`, and the only automatic non-tag actions need a route the
// owner stated.
//
// The store is a real file on purpose. Cursors, traces and patterns all
// accumulate across runs, and a pass that started from `:memory:` would cold
// start every time and never learn anything.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  JmapAdapter,
  MailStore,
  createLlmClassifier,
  describePass,
  runAgent,
  describeLearn,
  learn,
} from '../packages/dsh-mail-core/dist/index.js';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const WRITE = args.includes('--write');
const EVERY = arg('every', null);
const LIMIT = Number(arg('limit', '100'));
const STORE = arg('store', `${process.env.HOME}/.dsh/mail-agent.db`);
const FOLDER = arg('folder', 'INBOX');
const MODEL = arg('model', 'Mistral-Small-3.2-24B-Instruct-2506-FP8');
const BASE = (arg('base', process.env.MAIL_SENTINEL_API_BASE) ?? '').replace(/\/$/, '');
const THIRD_PARTY = args.includes('--accept-third-party');
const SOVEREIGN = /^https:\/\/chat\.lucie\.ovh\.linagora\.com(\/|$)/;
const KEY = THIRD_PARTY ? process.env.OPENROUTER_API_KEY : process.env.MAIL_SENTINEL_API_KEY;

if (!SOVEREIGN.test(BASE)) {
  if (!THIRD_PARTY) {
    console.error(`Refusing: ${BASE} is not the sovereign gateway.`);
    process.exit(2);
  }
  const line = (s) => console.error(`| ${s.padEnd(62)}|`);
  console.error('+' + '-'.repeat(63) + '+');
  line('THIRD-PARTY ENDPOINT: message content leaves the perimeter');
  line(`${BASE}  ${MODEL}`);
  console.error('+' + '-'.repeat(63) + '+');
}
if (WRITE) {
  console.error('\n  WRITING. Under the shipped policy that is tags only:');
  console.error('  every move and every deletion is `ask`, and nothing is proposed to anyone yet.\n');
}

const bearer = JSON.parse(process.env.MAIL_SENTINEL_JMAP_TOKENS).accessToken;
let apiUrl = null;
const transport = {
  async request(body) {
    if (apiUrl === null) {
      const s = await fetch(process.env.MAIL_SENTINEL_JMAP_SESSION_URL, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      apiUrl = (await s.json()).apiUrl;
    }
    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`JMAP ${r.status}`);
    return r.json();
  },
};

const mailbox = new JmapAdapter({
  transport,
  accountId: process.env.MAIL_SENTINEL_JMAP_ACCOUNT_ID,
  identityId: process.env.MAIL_SENTINEL_JMAP_IDENTITY_ID ?? 'x',
});

function ask(options) {
  return fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: options.model,
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: 'system', content: options.system },
        { role: 'user', content: options.messages[0].content.map((b) => b.text).join('') },
      ],
    }),
  });
}

const llm = {
  async *stream(options) {
    // A rate limit is the provider pacing us, not a verdict about the message.
    // The cascade now answers a failed call rather than throwing, so without
    // this a busy minute would file real mail as `needs-review`.
    let r = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      r = await ask(options);
      if (r.status !== 429 && r.status < 500) break;
      await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt));
    }
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
    const body = await r.json();
    yield { type: 'text-delta', index: 0, text: body.choices?.[0]?.message?.content ?? '' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};

mkdirSync(dirname(STORE), { recursive: true });
const store = new MailStore(STORE);
console.log(`  store ${STORE}`);

const options = {
  mailbox,
  store,
  context: {
    owner: process.env.MAIL_SENTINEL_OWNER ?? 'mmaudet@linagora.com',
    vipSenders: [],
    corporateDomains: ['linagora.com'],
    statedRoutes: [],
    threadCategory: null,
    learnedPatterns: [],
  },
  model: createLlmClassifier({ llm, provider: 'mail-llm-economy', model: MODEL }),
  folder: FOLDER,
  dryRun: !WRITE,
  limit: LIMIT,
};

let stopping = false;
process.on('SIGINT', () => {
  // Finish the pass in flight rather than abandoning it: a pass killed between
  // its writes and its cursor would redo them on the next run.
  console.log('\n  stopping after this pass');
  stopping = true;
});

for (;;) {
  const pass = await runAgent(options);
  console.log(`\n${describePass(pass)}`);

  // Learning after the pass, not before: what was just classified is the
  // evidence, and a pass that learned first would be a pass behind.
  if (pass.classified.length > 0) console.log(`  ${describeLearn(learn(store))}`);

  if (EVERY === null || stopping) break;
  await new Promise((r) => setTimeout(r, Number(EVERY) * 1000));
}
store.close();
