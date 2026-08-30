// Read-only check that the Gmail account is reachable over IMAP with XOAUTH2.
//
// The third Phase 1 target. Exercises `ImapFlowConnection`'s access-token path,
// which existed since the wire client was written and had never met a server
// that speaks it: the LINAGORA account advertises AUTH=PLAIN only.
//
//   node scripts/probe-gmail-imap.mjs
//
// EXAMINE and LIST only. Nothing is written, marked seen, moved or flagged.

import { ImapFlowConnection } from '../packages/dsh-mail-core/dist/adapters/imap-client.js';

const USER = process.env.MAIL_SENTINEL_GMAIL_USER;
const raw = process.env.MAIL_SENTINEL_GMAIL_TOKENS;
if (!USER || !raw) {
  console.error('MAIL_SENTINEL_GMAIL_USER and MAIL_SENTINEL_GMAIL_TOKENS must be set');
  process.exit(2);
}
const { accessToken, expiresAt } = JSON.parse(raw);
if (!accessToken) {
  console.error('no accessToken in the stored record');
  process.exit(2);
}
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

try {
  const boxes = await imap.listMailboxes();
  console.log(`${USER}: ${boxes.length} mailboxes`);
  for (const b of boxes.slice(0, 14)) {
    console.log(`  ${(b.specialUse ?? '').padEnd(10)} ${b.path}`);
  }

  // EXAMINE, not SELECT: read-only by protocol, so nothing is marked seen.
  const status = await imap.open('INBOX');
  console.log(`\nINBOX uidValidity=${status.uidValidity} uidNext=${status.uidNext}`);

  // Gmail's own labels appear as folders; the special-use attributes are what
  // the adapter resolves roles from, and Gmail names them under [Gmail]/.
  const special = boxes.filter((b) => b.specialUse !== null);
  console.log(`special-use folders: ${special.length}`);
  console.log('\nread-only throughout: LIST and EXAMINE only.');
} catch (err) {
  console.error('FAILED:', err.message);
  if (/AUTHENTICATE|invalid credentials/i.test(err.message)) {
    console.error('Check that IMAP is enabled in Gmail settings, and that the');
    console.error('token carries the https://mail.google.com/ scope.');
  }
  process.exitCode = 1;
} finally {
  await imap.close();
}
