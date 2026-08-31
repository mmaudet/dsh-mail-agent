// Draft the replies the owner asked for, from the line they gave for each.
//
//   node scripts/draft-from-instructions.mjs --in triage.json --out drafts.json \
//     --model mistralai/mistral-small-3.2-24b-instruct --accept-third-party
//
// The input is what the triage page collected: one message id and one line of
// intent per reply the owner wants. Nothing here decides *whether* to reply —
// the owner already did that — so this is the one place in the project where a
// model may commit something on their behalf, and only what the line says.
//
//   [{ "id": "...", "note": "lui confirmer qu'on est dispo le 8" }, ...]
//
// PERIMETER: received mail bodies and the owner's own instructions leave the
// perimeter. The banner says so.

import { readFileSync, writeFileSync } from 'node:fs';

import {
  JmapAdapter,
  learnStyle,
  describeStyle,
  renderDraftRequest,
  DRAFT_SYSTEM_PROMPT,
  cleanDraft,
} from '../packages/dsh-mail-core/dist/index.js';

import { assertBuilt } from './lib/built.mjs';

const PKG = new URL('../packages/dsh-mail-core/', import.meta.url).pathname;
assertBuilt(PKG);

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const IN = arg('in', null);
// Drafts the owner rewrote, newest first: [{subject, drafted, wanted}, ...]
const REFORMULATIONS = arg('reformulations', null);
const OUT = arg('out', null);
const MODEL = arg('model', 'mistralai/mistral-small-3.2-24b-instruct');
const BASE = (arg('base', process.env.MAIL_SENTINEL_API_BASE) ?? '').replace(/\/$/, '');
const OWNER = process.env.MAIL_SENTINEL_OWNER ?? '';
const THIRD_PARTY = args.includes('--accept-third-party');
const SOVEREIGN = /^https:\/\/inference\.linagora\.com(\/|$)/;

if (IN === null || OUT === null) {
  console.error('usage: draft-from-instructions.mjs --in triage.json --out drafts.json');
  process.exit(2);
}

const ENDPOINT = THIRD_PARTY ? 'https://openrouter.ai/api/v1' : BASE;
const APIKEY = THIRD_PARTY ? process.env.OPENROUTER_API_KEY : process.env.MAIL_SENTINEL_API_KEY;

if (!SOVEREIGN.test(ENDPOINT)) {
  if (!THIRD_PARTY) {
    console.error(`Refusing: ${ENDPOINT} is not the sovereign gateway.`);
    process.exit(2);
  }
  const line = (s) => console.error(`| ${s.padEnd(66)}|`);
  console.error('+' + '-'.repeat(67) + '+');
  line('THIRD-PARTY ENDPOINT: received mail and the owner\'s instructions leave');
  line('the perimeter. Some instructions carry prices and commitments.');
  line(`${ENDPOINT}  ${MODEL}`);
  console.error('+' + '-'.repeat(67) + '+\n');
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
  identityId: 'x',
});

const style = learnStyle(
  await adapter.getMessages(await adapter.messagesSince('Sent', new Date('2026-07-01'), 300)),
  { examples: 3 },
);
if (style === null) {
  console.error('Not enough replies to derive a style.');
  process.exit(2);
}
console.error(describeStyle(style));
console.error('');

const wanted = JSON.parse(readFileSync(IN, 'utf8'));
const reformulations = REFORMULATIONS === null ? [] : JSON.parse(readFileSync(REFORMULATIONS, 'utf8'));
if (reformulations.length > 0) {
  console.error(`${String(reformulations.length)} rewritten drafts carried into the prompt`);
}

// The owner's own names, so a greeting addressed to a colleague who has left
// is not mirrored back at the sender.
const identities = await adapter.identities();
const ownNames = [...new Set(identities.map((i) => i.name).filter((n) => n !== null))];
const messages = new Map((await adapter.getMessages(wanted.map((r) => r.id))).map((m) => [m.id, m]));

async function ask(user) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const r = await fetch(`${ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${APIKEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 900,
        messages: [
          { role: 'system', content: DRAFT_SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
      }),
    });
    if (r.ok) return (await r.json()).choices?.[0]?.message?.content ?? '';
    if (r.status !== 429 && r.status < 500) throw new Error(`${String(r.status)} ${await r.text()}`);
    await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
  }
  throw new Error('gave up');
}

const out = [];
for (const row of wanted) {
  const message = messages.get(row.id);
  if (message === undefined) {
    console.error(`  skipped ${row.id}: no longer in the mailbox`);
    continue;
  }
  const body = cleanDraft(
    await ask(
      renderDraftRequest({
        message,
        category: row.category ?? 'correspondance-commerciale-client',
        style,
        owner: OWNER,
        ownNames,
        instruction: row.note,
        reformulations,
      }),
    ),
  );
  out.push({
    id: row.id,
    to: `${message.from[0]?.name ?? ''} <${message.from[0]?.email ?? ''}>`.trim(),
    subject: message.subject,
    instruction: row.note,
    draft: body,
    // What the owner will actually check: did it say what they asked, and did
    // it stop there.
    words: body.split(/\s+/).filter(Boolean).length,
    gaps: (body.match(/\[[^\]]{2,40}\]/g) ?? []).length,
  });
  process.stderr.write(`  ${String(out.length)}/${String(wanted.length)}\r`);
}
process.stderr.write('\n');

writeFileSync(OUT, JSON.stringify(out, null, 2));
console.error(`wrote ${OUT}: ${String(out.length)} drafts`);
console.error(`  median length ${String(out.map((d) => d.words).sort((a, b) => a - b)[Math.floor(out.length / 2)])} words, owner writes ${String(style.medianWords)}`);
console.error(`  with a bracketed gap: ${String(out.filter((d) => d.gaps > 0).length)}`);
