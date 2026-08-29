// How many bulk messages land in `newsletter-tech` on a real signal, and how
// many on the default? No model calls: this reads headers only.
//
// The answer decides what declining to guess would cost. Node 4 currently
// settles every unsubscribe-carrying message at confidence 1, so a default is
// a permanent verdict node 7 cannot degrade.
//
//   node scripts/probe-newsletter-fallback.mjs [--limit 100]

import { JmapAdapter } from '../packages/dsh-mail-core/dist/adapters/jmap-adapter.js';

const args = process.argv.slice(2);
const i = args.indexOf('--limit');
const LIMIT = Number(i === -1 ? 100 : args[i + 1]);

const bearer = JSON.parse(process.env.MAIL_SENTINEL_JMAP_TOKENS).accessToken;
const ACC = process.env.MAIL_SENTINEL_JMAP_ACCOUNT_ID;

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
  identityId: 'unused',
});

// The same markers node 4 keys on, mirrored here so the probe measures the
// rule rather than a guess about it.
const PROMO = ['%', 'solde', 'promotion', 'promo', 'offre', 'semaine', 'rdv',
  'réduction', 'remise', 'deal', 'discount'];
const MACHINE = ['[repo]', 'pull request', 'notification', 'alerte', 'alert',
  'merged', 'deploy', 'new issue', 'issue #', 'ticket #'];
const hasAny = (s, m) => m.some((x) => s.includes(x));

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

let bulk = 0;
let promo = 0;
let notif = 0;
let fallback = 0;
const fallbackSubjects = [];

for (const m of messages) {
  if (m.listUnsubscribe.length === 0) continue;
  bulk += 1;
  const local = (m.from[0]?.email ?? '').toLowerCase().split('@')[0] ?? '';
  const subject = m.subject.toLowerCase();
  if (local.includes('promo') || hasAny(subject, PROMO)) promo += 1;
  else if (local.includes('notif') || hasAny(subject, MACHINE)) notif += 1;
  else {
    fallback += 1;
    if (fallbackSubjects.length < 12) fallbackSubjects.push(m.subject.slice(0, 62));
  }
}

console.log(`of ${messages.length} messages, ${bulk} carry List-Unsubscribe\n`);
console.log(`  ${String(promo).padStart(3)}  matched a promo signal`);
console.log(`  ${String(notif).padStart(3)}  matched a notification signal`);
console.log(`  ${String(fallback).padStart(3)}  matched nothing -> filed as newsletter-tech by default`);
console.log(
  `\n${bulk === 0 ? 'n/a' : `${((fallback / bulk) * 100).toFixed(0)}% of bulk is the default, at confidence 1`}`,
);
console.log('\nwhat the default is deciding, verbatim:');
for (const s of fallbackSubjects) console.log(`  - ${s}`);
