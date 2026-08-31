// What happened in the mailbox between two dates (PRD section 4.3).
//
//   node scripts/summarize-period.mjs --from 2026-08-24 --to 2026-08-31
//
// The PRD's headline section is the five most important messages of the
// period. It is not here, and the reason is measured: the category that would
// rank them is right about the band 69% of the time
// (docs/reviews/one-hundred-and-fifty.md), so a top five would be two wrong
// entries presented as the answer to "what mattered this week".
//
// What is here instead is arithmetic over headers — counts, threads, who
// wrote, which alias carried it, what the owner answered — plus the one
// judgement this project has measured properly: what still wants them.

import { writeFileSync } from 'node:fs';

import { DatabaseSync } from 'node:sqlite';

import {
  JmapAdapter,
  DRAFTABLE,
  pending,
} from '../packages/dsh-mail-core/dist/index.js';
import { summarizePeriod, describeDigest } from '../packages/dsh-mail-digest/dist/index.js';

import { assertBuilt } from './lib/built.mjs';

assertBuilt(new URL('../packages/dsh-mail-core/', import.meta.url).pathname);
assertBuilt(new URL('../packages/dsh-mail-digest/', import.meta.url).pathname);

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const TO = new Date(arg('to', new Date().toISOString().slice(0, 10)));
const FROM = new Date(arg('from', new Date(TO.getTime() - 7 * 86400000).toISOString().slice(0, 10)));
const STORES = arg('store', `${process.env.HOME}/.dsh/mail-agent.db`).split(',');
const OUT = arg('out', null);
const LIMIT = Number(arg('limit', '8'));

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

// Which addresses are the owner rather than a list they sit on. The account
// states it, so nothing here has to be configured or guessed.
const identities = await adapter.identities();
const ownAddresses = identities.map((i) => i.email);
console.error(`${String(ownAddresses.length)} identities: ${ownAddresses.slice(0, 4).join(', ')}…`);

const messages = await adapter.getMessages(await adapter.messagesSince('INBOX', FROM, 1200));
const sent = await adapter.getMessages(await adapter.messagesSince('Sent', FROM, 600));

const decisions = [];
const draftable = [...DRAFTABLE];
const categories = new Map();
for (const path of STORES) {
  const db = new DatabaseSync(path);
  for (const row of db.prepare('select message_id, category, used_model, decided_by from traces').all()) {
    decisions.push({
      messageId: row.message_id,
      category: row.category,
      usedModel: row.used_model === 1,
      decidedBy: row.decided_by,
    });
    if (draftable.includes(row.category)) categories.set(row.message_id, row.category);
  }
  db.close();
}

// The queue, through the same filters the owner works from.
const where = await adapter.locate([...categories.keys()]);
const byId = new Map(messages.map((m) => [m.id, m]));
const candidates = [...categories]
  .filter(([id]) => (where.get(id) ?? []).includes('INBOX') && byId.has(id))
  .map(([id, category]) => ({ message: byId.get(id), category }));
const waiting = pending(candidates, { ownAddresses, sent });

const digest = summarizePeriod(
  { messages, sent, decisions, waiting, ownAddresses },
  { from: FROM, to: TO },
);

console.log(describeDigest(digest, LIMIT));
if (OUT !== null) {
  writeFileSync(OUT, JSON.stringify(digest, null, 2));
  console.error(`\nwrote ${OUT}`);
}
