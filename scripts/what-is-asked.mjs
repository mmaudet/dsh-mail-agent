// What each queued message asks, listed before the owner dictates.
//
//   node scripts/what-is-asked.mjs --in queue.json --out asked.json
//
// The critique loop found fifteen unanswered questions across thirteen drafts
// and fixed none of them: the answers were never in the instruction, and the
// reviser may not invent. So the same question is asked earlier, of the person
// who has the answer.
//
// This runs before the triage page is built, so the page can show the list
// beside the dictation box without a model call in the browser.

import { readFileSync, writeFileSync } from 'node:fs';

import { JmapAdapter, parseAsks, renderAsked, ASKED_SYSTEM_PROMPT } from '../packages/dsh-mail-core/dist/index.js';

import { assertBuilt } from './lib/built.mjs';

assertBuilt(new URL('../packages/dsh-mail-core/', import.meta.url).pathname);

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const IN = arg('in', null);
const OUT = arg('out', null);
const MODEL = arg('model', 'Mistral-Small-3.2-24B-Instruct-2506-FP8');
const BASE = (arg('base', process.env.MAIL_SENTINEL_API_BASE) ?? '').replace(/\/$/, '');
const THIRD_PARTY = args.includes('--accept-third-party');
const SOVEREIGN = /^https:\/\/inference\.linagora\.com(\/|$)/;

if (IN === null || OUT === null) {
  console.error('usage: what-is-asked.mjs --in queue.json --out asked.json');
  process.exit(2);
}
const ENDPOINT = THIRD_PARTY ? 'https://openrouter.ai/api/v1' : BASE;
const KEY = THIRD_PARTY ? process.env.OPENROUTER_API_KEY : process.env.MAIL_SENTINEL_API_KEY;
if (!SOVEREIGN.test(ENDPOINT) && !THIRD_PARTY) {
  console.error(`Refusing: ${ENDPOINT} is not the sovereign gateway.`);
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
    body: JSON.stringify({ using, methodCalls }),
  });
  return r.json();
}
const adapter = new JmapAdapter({
  transport: { request: (b) => jmap(b.using, b.methodCalls) },
  accountId: ACC,
  identityId: process.env.MAIL_SENTINEL_JMAP_IDENTITY_ID ?? 'x',
});

async function ask(user) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const r = await fetch(`${ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 400,
        messages: [
          { role: 'system', content: ASKED_SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
      }),
    });
    if (r.ok) return (await r.json()).choices?.[0]?.message?.content ?? '';
    if (r.status !== 429 && r.status < 500) throw new Error(String(r.status));
    await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt));
  }
  return '';
}

const queue = JSON.parse(readFileSync(IN, 'utf8'));
const messages = new Map((await adapter.getMessages(queue.map((r) => r.id))).map((m) => [m.id, m]));

const out = [];
for (const row of queue) {
  const message = messages.get(row.id);
  if (message === undefined) continue;
  const asks = parseAsks(await ask(renderAsked(message)));
  out.push({ id: row.id, subject: message.subject, asks });
  process.stderr.write(`\r  ${String(out.length)}/${String(queue.length)}`);
}
process.stderr.write('\n');

writeFileSync(OUT, JSON.stringify(out, null, 2));
const asked = out.filter((r) => r.asks.length > 0);
console.log(`${String(out.length)} messages, ${String(asked.length)} ask something\n`);
for (const r of asked) {
  console.log(`  ${r.subject.slice(0, 52)}`);
  for (const a of r.asks) console.log(`     · ${a}`);
}
