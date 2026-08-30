// The queue of messages still waiting on the owner, as JSON.
//
//   node scripts/pending-queue.mjs [--since 2026-08-24] [--out queue.json]
//
// Reads what the agent has classified out of its own store, keeps the
// categories a reply can be drafted for, and puts the result through
// `pending()` — which drops what the owner has already answered and what they
// sent themselves, and sorts what is left by whether it names them.
//
// The first version of this had none of those rules and offered forty messages
// of which four were waiting (docs/reviews/forty-dispositions.md).

import { writeFileSync } from 'node:fs';

import { DatabaseSync } from 'node:sqlite';

import {
  JmapAdapter,
  DRAFTABLE,
  pending,
  summarise,
  describeQueue,
} from '../packages/dsh-mail-core/dist/index.js';

import { assertBuilt } from './lib/built.mjs';

const PKG = new URL('../packages/dsh-mail-core/', import.meta.url).pathname;
assertBuilt(PKG);

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const SINCE = new Date(arg('since', '2026-08-24'));
const OUT = arg('out', null);
const STORES = arg('store', `${process.env.HOME}/.dsh/mail-agent.db`).split(',');
const OWN = (process.env.MAIL_SENTINEL_OWN_ADDRESSES ?? process.env.MAIL_SENTINEL_OWNER ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '');

if (OWN.length === 0) {
  console.error('Refusing: set MAIL_SENTINEL_OWN_ADDRESSES to the addresses that are the owner.');
  console.error('A team alias is not one of them, and nothing in a message says which is which.');
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
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls }),
  });
  return r.json();
}
const adapter = new JmapAdapter({
  transport: { request: (b) => jmap(b.methodCalls) },
  accountId: ACC,
  identityId: 'x',
});

const draftable = [...DRAFTABLE];
const category = new Map();
for (const path of STORES) {
  const db = new DatabaseSync(path);
  const rows = db
    .prepare(
      `select message_id, category from traces
        where category in (${draftable.map(() => '?').join(',')})
        order by started_at desc limit 600`,
    )
    .all(...draftable);
  for (const row of rows) category.set(row.message_id, row.category);
  db.close();
}
console.error(`${String(category.size)} classified as needing the owner`);

const messages = await adapter.getMessages([...category.keys()]);
// Filed or deleted mail is mail the owner has dealt with by moving it. What
// this cannot see is the mail they answered and left where it was, which is
// why `pending` checks the Sent folder rather than trusting the inbox.
const where = await adapter.locate(messages.map((m) => m.id));
const candidates = messages
  .filter((m) => (where.get(m.id) ?? []).includes('INBOX'))
  .map((m) => ({ message: m, category: category.get(m.id) }));

const sent = await adapter.getMessages(await adapter.messagesSince('Sent', SINCE, 600));
console.error(`${String(sent.length)} replies in Sent since ${SINCE.toISOString().slice(0, 10)}`);

const options = { ownAddresses: OWN, sent };
const queue = pending(candidates, options);
console.error(describeQueue(summarise(candidates, options, queue)));

const out = queue.map((item, i) => ({
  n: i + 1,
  id: item.message.id,
  category: item.category,
  addressing: item.addressing,
  from: `${item.message.from[0]?.name ?? ''} <${item.message.from[0]?.email ?? ''}>`.trim(),
  to: item.message.to.map((a) => a.email),
  subject: item.message.subject || '(sans objet)',
  date: item.message.receivedAt.toISOString(),
  body: (item.message.bodyText ?? item.message.preview ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('>'))
    .join('\n')
    .trim()
    .slice(0, 1600),
}));

if (OUT === null) console.log(JSON.stringify(out, null, 2));
else {
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(`wrote ${OUT}`);
}
