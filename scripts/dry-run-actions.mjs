// What the agent would do to a real mailbox, and — with --execute — does.
//
//   node scripts/dry-run-actions.mjs [--limit 30]
//   node scripts/dry-run-actions.mjs [--limit 30] --execute
//
// Classifies, plans, and applies only what the approval policy marks
// automatic. Dry run by default; `--execute` is the one way anything changes.
//
// Traces go to $DSH_HOME/mail.sqlite, written before any mailbox write and in
// a dry run too: a plan considered and not applied is still a decision worth a
// record.

import { homedir } from 'node:os';
import { join } from 'node:path';

import { JmapAdapter } from '../packages/dsh-mail-core/dist/adapters/jmap-adapter.js';
import { runCascade } from '../packages/dsh-mail-core/dist/cascade/cascade-loop.js';
import { createLlmClassifier } from '../packages/dsh-mail-core/dist/cascade/llm-classifier.js';
import { DEFAULT_POLICY, describePolicy } from '../packages/dsh-mail-core/dist/actions/approval.js';
import { describePlan, planActions } from '../packages/dsh-mail-core/dist/actions/plan.js';
import { executePlan } from '../packages/dsh-mail-core/dist/actions/execute.js';
import { MailStore } from '../packages/dsh-mail-core/dist/store/mail-store.js';

const args = process.argv.slice(2);
const li = args.indexOf('--limit');
const LIMIT = Number(li === -1 ? 30 : args[li + 1]);
const EXECUTE = args.includes('--execute');

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
  identityId: process.env.MAIL_SENTINEL_JMAP_IDENTITY_ID ?? 'unused',
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

const store = new MailStore(
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'mail.sqlite'),
);

const context = {
  owner: process.env.MAIL_SENTINEL_OWNER ?? 'mmaudet@linagora.com',
  vipSenders: (process.env.MAIL_SENTINEL_VIP ?? '').split(',').filter(Boolean),
  corporateDomains: (process.env.MAIL_SENTINEL_CORPORATE ?? 'linagora.com').split(',').filter(Boolean),
  threadCategory: null,
  learnedPatterns: store.loadPatterns(),
};

console.log(describePolicy(DEFAULT_POLICY));
console.log(`\n${EXECUTE ? 'EXECUTING' : 'dry run — nothing will change'}, limit ${LIMIT}`);
console.log(`${context.learnedPatterns.length} learned pattern(s) in store\n`);

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

let performed = 0;
let proposedCount = 0;
let failed = 0;

for (const message of messages) {
  let trace;
  try {
    trace = await runCascade(message, { context, model });
  } catch (err) {
    console.log(`  !  ${String(err.message).slice(0, 80)}`);
    failed += 1;
    continue;
  }

  const plan = planActions(trace, adapter.capabilities, DEFAULT_POLICY);
  const result = await executePlan(trace, plan, adapter, store, { dryRun: !EXECUTE });

  performed += result.performed.length;
  proposedCount += result.proposed.length;
  failed += result.failed.length;

  const subject = (message.subject || '(no subject)').slice(0, 40).padEnd(40);
  console.log(`${trace.category.padEnd(24)} ${subject} ${trace.confidence.toFixed(2)}`);
  if (plan.length > 0) console.log(describePlan(plan));
  for (const f of result.failed) console.log(`        FAILED ${f.action.action}: ${f.error.slice(0, 70)}`);
}

const eff = store.efficiency();
console.log(`\n--- ${EXECUTE ? 'applied' : 'would apply'} ---`);
console.log(`  actions ${EXECUTE ? 'performed' : 'planned'} : ${performed}`);
console.log(`  awaiting the owner      : ${proposedCount}`);
console.log(`  failed                  : ${failed}`);
console.log(`\n--- from the store, all time ---`);
console.log(`  classified   : ${eff.classified}`);
console.log(`  model calls  : ${eff.withModel}`);
console.log(
  `  settled free : ${eff.settledFree === null ? 'n/a' : `${(eff.settledFree * 100).toFixed(0)}%`}`,
);
store.close();
console.log(EXECUTE ? '\nApplied.' : '\nNothing was changed.');
