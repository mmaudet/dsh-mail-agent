// The recurrence ceiling of an IMAP mailbox, for comparison with the JMAP one.
//
// The work mailbox measured 64% of messages coming from a source seen three or
// more times, and only 19% from a source the classifier answers consistently —
// because most of a work inbox is written by colleagues, and a person is not a
// category.
//
// A personal mailbox is made of different things: services, shops, newsletters.
// If the cascade is built for automated senders, it should do markedly better
// there. This measures whether that is true, from headers alone.
//
//   node scripts/probe-recurrence-imap.mjs [--limit 500] [--min 3]
//
// Read-only: EXAMINE and a header fetch. Nothing is written or marked seen.

import { ImapFlowConnection } from '../packages/dsh-mail-core/dist/adapters/imap-client.js';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return Number(i === -1 ? d : args[i + 1]);
};
const LIMIT = flag('limit', 500);
const MIN = flag('min', 3);
const fi = args.indexOf('--folder');
// The inbox of a triaged mailbox is what is left, not what arrived. On Gmail
// the whole stream is in All Mail.
const FOLDER = fi === -1 ? 'INBOX' : args[fi + 1];

const USER = process.env.MAIL_SENTINEL_GMAIL_USER;
const raw = process.env.MAIL_SENTINEL_GMAIL_TOKENS;
if (!USER || !raw) {
  console.error('MAIL_SENTINEL_GMAIL_USER and MAIL_SENTINEL_GMAIL_TOKENS must be set');
  process.exit(2);
}
const { accessToken, expiresAt } = JSON.parse(raw);
if (expiresAt && new Date(expiresAt) < new Date()) {
  console.error(`token expired at ${expiresAt} — run: mail-auth gmail refresh`);
  process.exit(2);
}

const imap = new ImapFlowConnection({
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  user: USER,
  accessToken,
});

const rows = [];
try {
  const status = await imap.open(FOLDER);
  // The newest LIMIT messages: a window, not the whole mailbox.
  const from = Math.max(1, status.uidNext - LIMIT);
  const uids = (await imap.searchFrom(FOLDER, from)).slice(-LIMIT);
  console.log(`${FOLDER}: ${uids.length} recent message(s) of uidNext ${status.uidNext}\n`);

  for (let at = 0; at < uids.length; at += 50) {
    const batch = await imap.fetchByUid(FOLDER, uids.slice(at, at + 50));
    for (const m of batch) {
      rows.push({
        sender: (m.envelope.from[0]?.email ?? '').toLowerCase(),
        listId: listIdOf(m.headers['list-id']),
        day: m.internalDate.toISOString().slice(0, 10),
      });
    }
  }
} finally {
  await imap.close();
}

function listIdOf(header) {
  const m = /<([^>]+)>/.exec(header ?? '');
  return m?.[1]?.trim().toLowerCase() ?? null;
}

const bySource = new Map();
for (const r of rows) {
  const key = r.listId !== null ? `list:${r.listId}` : `from:${r.sender}`;
  const b = bySource.get(key) ?? { count: 0, days: new Set() };
  b.count += 1;
  b.days.add(r.day);
  bySource.set(key, b);
}

const sources = [...bySource.entries()].sort((a, b) => b[1].count - a[1].count);
const recurring = sources.filter(([, v]) => v.count >= MIN);
const covered = recurring.reduce((n, [, v]) => n + v.count, 0);
const multiDay = recurring.filter(([, v]) => v.days.size >= 2);
const multiDayCovered = multiDay.reduce((n, [, v]) => n + v.count, 0);
const span = new Set(rows.map((r) => r.day)).size;

console.log(`${rows.length} messages over ${span} day(s), ${sources.length} distinct sources\n`);
console.log(`sources seen ${MIN}+ times : ${recurring.length}`);
console.log(`messages they account for  : ${covered} (${((covered / rows.length) * 100).toFixed(0)}%)`);
console.log(`recurring across 2+ days   : ${multiDay.length} sources, ${multiDayCovered} messages (${((multiDayCovered / rows.length) * 100).toFixed(0)}%)`);

// The distinction that decided the work mailbox: a service emits one kind of
// message, a person does not.
const AUTOMATED = /no[-.]?reply|noreply|notification|notifications|newsletter|news@|info@|support@|contact@|hello@|team@|mailer|bounce|donotreply|alerts?@/i;
const automated = recurring.filter(([k]) => k.startsWith('list:') || AUTOMATED.test(k));
const automatedCovered = automated.reduce((n, [, v]) => n + v.count, 0);
console.log(
  `\nof the recurring, machine-looking : ${automated.length} sources, ${automatedCovered} messages (${((automatedCovered / rows.length) * 100).toFixed(0)}%)`,
);
console.log('  ↑ a rough proxy for what a stable-category source looks like.');

console.log('\ntop sources:');
for (const [key, v] of sources.slice(0, 18)) {
  console.log(`  ${String(v.count).padStart(4)}  over ${String(v.days.size).padStart(3)}d  ${key.slice(0, 60)}`);
}
console.log('\nRead-only throughout.');
