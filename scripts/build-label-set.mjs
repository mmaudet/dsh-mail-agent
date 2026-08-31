// Build a blind labelling set: N messages, sender, subject and preview only.
//
// The first set was thirty, and thirty was too few to separate any hypothesis
// from any other — 5 of 15 and 2 of 9 sat inside each other's error bars, so
// every conclusion it could support was a negative one. This builds the set
// that can carry a positive claim.
//
//   node scripts/build-label-set.mjs [--count 150] [--window 1500]
//
// Writes the set to --out and the message ids to --ids. The ids matter: the
// inbox takes two hundred messages a day, so anything that re-derives the
// sample later by position lines the labels up with different mail.
//
// The model's answer is never computed here and never shown. An anchored label
// measures the anchor.

import { writeFileSync } from 'node:fs';

import { JmapAdapter } from '../packages/dsh-mail-core/dist/adapters/jmap-adapter.js';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const COUNT = Number(arg('count', '150'));
const WINDOW = Number(arg('window', '1500'));
const OUT = arg('out', '/tmp/label-set-150.json');
const IDS = arg('ids', '/tmp/label-ids-150.json');

const ACC = process.env.MAIL_SENTINEL_JMAP_ACCOUNT_ID;
const bearer = JSON.parse(process.env.MAIL_SENTINEL_JMAP_TOKENS).accessToken;

let apiUrl = null;
async function jmap(using, methodCalls) {
  if (!apiUrl) {
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
  identityId: 'x',
});

const boxes = await jmap([['Mailbox/get', { accountId: ACC, ids: null }, 'c']]);
const inbox = boxes.methodResponses[0][1].list.find((m) => m.role === 'inbox');

// Spread across the window rather than taking the newest N: a day of mail is
// one day's mix, and the set should look like the mailbox.
const ids = [];
while (ids.length < WINDOW) {
  const page = await jmap([['Email/query', {
    accountId: ACC, filter: { inMailbox: inbox.id },
    sort: [{ property: 'receivedAt', isAscending: false }],
    position: ids.length, limit: 256,
  }, 'q']]);
  const got = page.methodResponses[0][1].ids;
  if (got.length === 0) break;
  ids.push(...got);
}
if (ids.length < WINDOW) {
  console.error(`window is ${ids.length}, asked for ${WINDOW}`);
}

const step = Math.max(1, Math.floor(ids.length / COUNT));
const picked = ids.filter((_, i) => i % step === 0).slice(0, COUNT);
if (picked.length < COUNT) {
  console.error(`Refusing: could only pick ${picked.length} of ${COUNT}.`);
  process.exit(2);
}

const messages = await adapter.getMessages(picked);
const byId = new Map(messages.map((m) => [m.id, m]));

const set = [];
const pins = [];
for (const [i, id] of picked.entries()) {
  const m = byId.get(id);
  if (m === undefined) continue;
  const from = m.from[0];
  const n = i + 1;
  set.push({
    n,
    from: `${from?.name ?? ''} <${from?.email ?? ''}>`.trim(),
    subject: m.subject || '(sans objet)',
    preview: (m.bodyText ?? m.preview ?? '').replace(/\s+/g, ' ').trim().slice(0, 220),
    date: m.receivedAt ?? null,
  });
  pins.push({ n, id });
}

if (set.length !== COUNT) {
  console.error(`Refusing: built ${set.length} of ${COUNT}; the set and the ids must agree.`);
  process.exit(2);
}

writeFileSync(OUT, JSON.stringify(set, null, 2));
writeFileSync(IDS, JSON.stringify(pins, null, 2));
console.log(`${set.length} messages spread over ${ids.length}, every ${step}th`);
console.log(`  set -> ${OUT}`);
console.log(`  ids -> ${IDS}`);
