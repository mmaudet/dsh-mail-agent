// Which Gmail labels have gone quiet, and since when.
//
// Read-only: EXAMINE and FETCH of one date per folder. Nothing is created,
// moved, flagged or deleted. It produces the list a person then decides about.
//
//   node scripts/probe-gmail-stale-labels.mjs [--since 2026-01-01]
//
// Worth knowing before deciding: on Gmail a folder is a label, and deleting a
// label does not delete its messages. They keep every other label they carry
// and remain in [Gmail]/Tous les messages. It is a reversible-ish operation on
// organisation, not on mail — but "ish" is doing work, because the label
// itself, and which messages carried it, is not recoverable.

import { ImapFlowConnection } from '../packages/dsh-mail-core/dist/adapters/imap-client.js';

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

const i = process.argv.indexOf('--since');
const SINCE = new Date(i === -1 ? '2026-01-01' : process.argv[i + 1]);

const imap = new ImapFlowConnection({
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  user: USER,
  accessToken,
});

// Gmail's own containers are not the owner's organisation and are not
// candidates for anything.
const SYSTEM = /^\[Gmail\]/;

const rows = [];
try {
  const boxes = await imap.listMailboxes();
  for (const box of boxes) {
    if (box.path === 'INBOX' || SYSTEM.test(box.path)) continue;
    try {
      const status = await imap.open(box.path);
      const uids = await imap.searchFrom(box.path, 1);
      let newest = null;
      if (uids.length > 0) {
        // Only the newest message's date is needed, so only it is fetched.
        const last = Math.max(...uids);
        const [message] = await imap.fetchByUid(box.path, [last]);
        newest = message?.internalDate ?? null;
      }
      rows.push({ path: box.path, exists: uids.length, newest, note: null, uidNext: status.uidNext });
    } catch (err) {
      // A container label cannot be opened; that is not a failure to report as
      // one.
      rows.push({ path: box.path, exists: null, newest: null, note: 'not selectable' });
    }
  }
} finally {
  await imap.close();
}

rows.sort((a, b) => (a.newest?.getTime() ?? 0) - (b.newest?.getTime() ?? 0));

const fmt = (d) => (d === null ? '        never' : d.toISOString().slice(0, 10));
console.log(`${rows.length} owner label(s) on ${USER}\n`);
console.log('  last message   count  label');
for (const r of rows) {
  const stale = r.newest === null || r.newest < SINCE;
  console.log(
    `${stale ? '·' : ' '} ${fmt(r.newest)}  ${String(r.exists ?? '—').padStart(6)}  ${r.path}${r.note ? `  (${r.note})` : ''}`,
  );
}

const stale = rows.filter((r) => r.newest === null || r.newest < SINCE);
const empty = stale.filter((r) => (r.exists ?? 0) === 0);
console.log(`\n· = nothing since ${SINCE.toISOString().slice(0, 10)}: ${stale.length} label(s)`);
console.log(`  of which empty: ${empty.length}`);
console.log(`  holding messages: ${stale.length - empty.length}`);
console.log('\nRead-only. Nothing was changed.');
