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

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  JmapAdapter,
  MailStore,
  backfill,
  createLlmClassifier,
  describeBackfill,
  describeLearn,
  describePass,
  learn,
  runAgent,
} from '../packages/dsh-mail-core/dist/index.js';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const WRITE = args.includes('--write');
// Replays a stretch of history instead of polling. The two are separate on
// purpose: a backfill reaches backwards and never touches the poll's cursor.
const SINCE = arg('since', null);
const EVERY = arg('every', null);
// A backfill covers a week; a poll covers three minutes. One default cannot
// serve both, and a hundred would silently truncate the week.
const SINCE_DEFAULT_LIMIT = () => (args.includes('--since') ? '3000' : '100');
// A poll can afford to give up and let the next pass retry three minutes
// later. A backfill has no next pass, so it waits the provider out.
const RETRIES = Number(arg('retries', args.includes('--since') ? '7' : '4'));
const LIMIT = Number(arg('limit', SINCE_DEFAULT_LIMIT()));
const STORE = arg('store', `${process.env.HOME}/.dsh/mail-agent.db`);
const FOLDER = arg('folder', 'INBOX');
const MODEL = arg('model', 'Mistral-Small-3.2-24B-Instruct-2506-FP8');
const BASE = (arg('base', process.env.MAIL_SENTINEL_API_BASE) ?? '').replace(/\/$/, '');
const THIRD_PARTY = args.includes('--accept-third-party');
const SOVEREIGN = /^https:\/\/inference\.linagora\.com(\/|$)/;
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

// The access token lives about ten hours. A loop meant to run overnight will
// meet its expiry, and every JMAP call then answers 401 — which without this
// ends the process on a schedule.
//
// The refresh writes a new token into the env file and this re-reads it, so
// the running process picks it up without being restarted.
const ENV_FILE = `${process.env.HOME}/.dsh/.env`;
let bearer = JSON.parse(process.env.MAIL_SENTINEL_JMAP_TOKENS).accessToken;

function reloadToken() {
  const line = readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('MAIL_SENTINEL_JMAP_TOKENS='));
  if (line === undefined) return false;
  const raw = line.slice('MAIL_SENTINEL_JMAP_TOKENS='.length).replace(/^'|'$/g, '');
  const fresh = JSON.parse(raw).accessToken;
  if (fresh === bearer) return false;
  bearer = fresh;
  return true;
}

function refreshToken() {
  const result = spawnSync('python3', [`${process.cwd()}/scripts/refresh-jmap-token.py`], {
    encoding: 'utf8',
    env: process.env,
  });
  console.log(`  token refresh: ${(result.stdout || result.stderr || '').trim().slice(0, 120)}`);
  return result.status === 0 && reloadToken();
}

let apiUrl = null;
async function jmapCall(body) {
  if (apiUrl === null) {
    const s = await fetch(process.env.MAIL_SENTINEL_JMAP_SESSION_URL, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!s.ok) return { status: s.status, json: null };
    apiUrl = (await s.json()).apiUrl;
  }
  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: r.ok ? await r.json() : null };
}

const transport = {
  async request(body) {
    let attempt = await jmapCall(body);
    if (attempt.status === 401) {
      // The session url is cached against the old token; drop it so the
      // rediscovery runs with the new one.
      apiUrl = null;
      if (!refreshToken()) throw new Error('JMAP 401 and the token could not be refreshed');
      attempt = await jmapCall(body);
    }
    // A 500 from the mail server is weather, not a verdict. The agent survived
    // an unreachable *model* from the first day and had nothing for an
    // unreachable *mailbox*: one 500 during a delta poll ended the process.
    for (let wait = 2000; attempt.json === null && attempt.status >= 500 && wait <= 16000; wait *= 2) {
      console.error(`  JMAP ${String(attempt.status)}, retrying in ${String(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
      apiUrl = null;
      attempt = await jmapCall(body);
    }
    if (attempt.json === null) throw new Error(`JMAP ${String(attempt.status)}`);
    return attempt.json;
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
    // The cascade answers a failed call rather than throwing, so without this
    // a busy minute files real mail as `needs-review` — measured on a backfill,
    // where four attempts left 11 messages in 20 unclassified.
    //
    // The 429 here is `engine_overloaded` on a shared upstream pool, whose
    // remedy is to wait. A backfill is not latency-sensitive, so it waits:
    // seven attempts reaching a minute, rather than four reaching twelve
    // seconds.
    let r = null;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      r = await ask(options);
      if (r.status !== 429 && r.status < 500) break;
      const wait = Math.min(60000, 2000 * 2 ** attempt);
      await new Promise((res) => setTimeout(res, wait));
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

if (SINCE !== null) {
  const since = new Date(SINCE);
  if (Number.isNaN(since.getTime())) {
    console.error(`Not a date: ${SINCE}`);
    process.exit(2);
  }
  const result = await backfill({
    ...options,
    since,
    limit: LIMIT,
    pageSize: 25,
    onPage: (done) => process.stderr.write(`\r  ${String(done)} examined`),
  });
  process.stderr.write('\n');
  console.log(`\n${describeBackfill(result)}`);
  if (result.classified.length > 0) console.log(`  ${describeLearn(learn(store))}`);
  store.close();
  process.exit(0);
}

let stopping = false;
process.on('SIGINT', () => {
  // Finish the pass in flight rather than abandoning it: a pass killed between
  // its writes and its cursor would redo them on the next run.
  console.log('\n  stopping after this pass');
  stopping = true;
});

// Consecutive failed passes, so a mailbox that is down for an hour is visible
// in the log rather than only in the gaps between passes.
let failures = 0;
for (;;) {
  try {
    const pass = await runAgent(options);
    failures = 0;
    console.log(`\n${describePass(pass)}`);

    // Learning after the pass, not before: what was just classified is the
    // evidence, and a pass that learned first would be a pass behind.
    if (pass.classified.length > 0) console.log(`  ${describeLearn(learn(store))}`);
  } catch (err) {
    // A pass that throws is a pass lost, not a run lost. The cursor only moves
    // on a pass that finished, so the next one sees the same mail again.
    failures += 1;
    console.error(
      `\n  pass failed (${String(failures)} in a row): ${err instanceof Error ? err.message : String(err)}`,
    );
    if (EVERY === null) throw err;
  }

  if (EVERY === null || stopping) break;
  // Back off while it keeps failing, up to eight intervals, so a mailbox that
  // is down is not hammered every three minutes.
  const wait = Number(EVERY) * Math.min(2 ** failures, 8) * 1000;
  await new Promise((r) => setTimeout(r, wait));
}
store.close();
