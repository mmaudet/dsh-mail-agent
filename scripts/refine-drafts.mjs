// Draft, criticise, revise, repeat — and measure whether it was worth it.
//
//   node scripts/refine-drafts.mjs --in triage.json --out refined.json
//
// The owner proposed looping until two models agree the draft is acceptable.
// The loop is here; the stopping rule is not agreement but an absence of
// faults, because two models agreeing is not evidence — they share their blind
// spots, and optimising for agreement converges on a fluent draft carrying a
// commitment nobody made.
//
// So the critic reports three faults and may not propose content, and this
// script measures the one risk that matters: words appearing in the revised
// draft that are in neither the instruction nor the message. That count is
// arithmetic, not a second opinion.

import { readFileSync, writeFileSync } from 'node:fs';

import {
  JmapAdapter,
  learnStyle,
  renderDraftRequest,
  renderCritique,
  renderRevision,
  parseFindings,
  cleanDraft,
  DRAFT_SYSTEM_PROMPT,
  CRITIQUE_SYSTEM_PROMPT,
  MAX_ROUNDS,
} from '../packages/dsh-mail-core/dist/index.js';

import { assertBuilt } from './lib/built.mjs';

assertBuilt(new URL('../packages/dsh-mail-core/', import.meta.url).pathname);

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const IN = arg('in', null);
const OUT = arg('out', null);
const REFORMULATIONS = arg('reformulations', null);
const MODEL = arg('model', 'Mistral-Small-3.2-24B-Instruct-2506-FP8');
// A second opinion is worth more from a different model, when there is one.
const CRITIC = arg('critic', MODEL);
const ROUNDS = Number(arg('rounds', String(MAX_ROUNDS)));
const BASE = (arg('base', process.env.MAIL_SENTINEL_API_BASE) ?? '').replace(/\/$/, '');
const THIRD_PARTY = args.includes('--accept-third-party');
const SOVEREIGN = /^https:\/\/inference\.linagora\.com(\/|$)/;

if (IN === null || OUT === null) {
  console.error('usage: refine-drafts.mjs --in triage.json --out refined.json');
  process.exit(2);
}

const ENDPOINT = THIRD_PARTY ? 'https://openrouter.ai/api/v1' : BASE;
const KEY = THIRD_PARTY ? process.env.OPENROUTER_API_KEY : process.env.MAIL_SENTINEL_API_KEY;
if (!SOVEREIGN.test(ENDPOINT)) {
  if (!THIRD_PARTY) {
    console.error(`Refusing: ${ENDPOINT} is not the sovereign gateway.`);
    process.exit(2);
  }
  console.error(`THIRD-PARTY ENDPOINT: ${ENDPOINT} — received mail and instructions leave the perimeter\n`);
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
    body: JSON.stringify({ using, methodCalls }),
  });
  return r.json();
}
const adapter = new JmapAdapter({
  transport: { request: (b) => jmap(b.using, b.methodCalls) },
  accountId: ACC,
  identityId: process.env.MAIL_SENTINEL_JMAP_IDENTITY_ID ?? 'x',
});

async function ask(model, system, user, maxTokens = 900) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const r = await fetch(`${ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (r.ok) return (await r.json()).choices?.[0]?.message?.content ?? '';
    if (r.status !== 429 && r.status < 500) throw new Error(String(r.status));
    await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt));
  }
  throw new Error('gave up');
}

const style = learnStyle(
  await adapter.getMessages(await adapter.messagesSince('Sent', new Date('2026-07-01'), 300)),
  { examples: 3 },
);
const identities = await adapter.identities();
const ownNames = [...new Set(identities.map((i) => i.name).filter((n) => n !== null))];
const reformulations = REFORMULATIONS === null ? [] : JSON.parse(readFileSync(REFORMULATIONS, 'utf8'));

const wanted = JSON.parse(readFileSync(IN, 'utf8'));
const messages = new Map((await adapter.getMessages(wanted.map((r) => r.id))).map((m) => [m.id, m]));

// Content words in the draft that are in neither the instruction nor the
// message. The one measure here that is arithmetic rather than an opinion.
const STOP = new Set(
  ('le la les un une des de du au aux et ou a en pour par sur dans que qui quoi ce cette ces je tu il elle nous vous ils elles me te se son sa ses leur leurs mon ma mes votre vos notre nos est sont ete avoir etre fait faire bien tres plus bonjour bonsoir cordialement merci si ne pas plus avec sans dont mais donc or ni car y en').split(' '),
);
const bag = (t) =>
  new Set(
    t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{4,}/g)?.filter((w) => !STOP.has(w)) ?? [],
  );
const unsupported = (draft, sources) => {
  const known = bag(sources);
  return [...bag(draft)].filter((w) => !known.has(w));
};

const words = (t) => t.split(/\s+/).filter(Boolean).length;
const out = [];
for (const row of wanted) {
  const message = messages.get(row.id);
  if (message === undefined) continue;
  const base = {
    message,
    category: row.category ?? 'correspondance-commerciale-client',
    style,
    owner: process.env.MAIL_SENTINEL_OWNER ?? '',
    ownNames,
    instruction: row.note,
    reformulations,
  };
  let draft = cleanDraft(await ask(MODEL, DRAFT_SYSTEM_PROMPT, renderDraftRequest(base)));
  const first = draft;
  const history = [];
  let rounds = 0;
  let remaining = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const findings = parseFindings(
      await ask(CRITIC, CRITIQUE_SYSTEM_PROMPT, renderCritique(message, row.note, draft), 600),
    );
    history.push(findings);
    if (findings.length === 0) {
      remaining = [];
      break;
    }
    remaining = findings;
    draft = cleanDraft(
      await ask(MODEL, DRAFT_SYSTEM_PROMPT, `${renderDraftRequest(base)}\n\n---\n\n${renderRevision(draft, findings)}`),
    );
    rounds += 1;
  }
  const sources = `${row.note}\n${message.bodyText ?? message.preview}`;
  out.push({
    id: row.id,
    subject: message.subject,
    instruction: row.note,
    first,
    draft,
    rounds,
    remaining,
    history,
    wordsBefore: words(first),
    wordsAfter: words(draft),
    newWordsBefore: unsupported(first, sources).length,
    newWordsAfter: unsupported(draft, sources).length,
  });
  process.stderr.write(`\r  ${String(out.length)}/${String(wanted.length)}`);
}
process.stderr.write('\n');

writeFileSync(OUT, JSON.stringify(out, null, 2));
const mean = (xs) => (xs.length === 0 ? 0 : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length));
console.log(`${String(out.length)} drafts, ${String(ROUNDS)} rounds allowed\n`);
console.log(`  revisions actually run      ${String(out.reduce((a, r) => a + r.rounds, 0))}`);
console.log(`  clean on the first review   ${String(out.filter((r) => r.rounds === 0).length)}/${String(out.length)}`);
console.log(`  still faulted at the end    ${String(out.filter((r) => r.remaining.length > 0).length)}/${String(out.length)}`);
console.log(`\n  words        before ${String(mean(out.map((r) => r.wordsBefore))).padStart(3)}   after ${String(mean(out.map((r) => r.wordsAfter))).padStart(3)}`);
console.log(`  words in neither source  before ${String(mean(out.map((r) => r.newWordsBefore))).padStart(3)}   after ${String(mean(out.map((r) => r.newWordsAfter))).padStart(3)}`);
const kinds = {};
for (const r of out) for (const round of r.history) for (const f of round) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
console.log(`\n  faults raised: ${Object.entries(kinds).map(([k, n]) => `${k} ${String(n)}`).join(', ') || 'none'}`);
