// Remove named Gmail labels, after checking each is what the operator thought.
//
//   node scripts/gmail-remove-labels.mjs --lot 1            # dry run
//   node scripts/gmail-remove-labels.mjs --lot 1 --execute
//
// Dry run by default. `--execute` is the only way anything changes, and every
// label is re-checked immediately before it goes: a list decided ten minutes
// ago is a claim about the past.
//
// On Gmail a label is not a folder of copies. Removing one leaves its messages
// alone — they keep every other label and remain in [Gmail]/Tous les messages.
// What does not come back is the label and the knowledge of which messages
// carried it.

import { ImapFlowConnection } from '../packages/dsh-mail-core/dist/adapters/imap-client.js';

// Exactly what was agreed, written down rather than derived, so that a
// re-measurement between deciding and doing cannot widen the list.
const LOTS = {
  1: {
    label: 'empty labels',
    expect: 'empty',
    paths: [
      '[Mailbox]/Later',
      '[Mailbox]/To Buy',
      '[Mailbox]/To Read',
      '[Mailbox]/To Watch',
      'Actioned',
      'Awaiting Reply',
      'Cold Email',
      'Customer Feedback',
      'Drafts',
      'FYI',
      'Investor',
      'Notes',
      'Personnel',
      'Professionnel',
      'Receipt',
      'Reçus',
      'To Reply',
      'Urgent',
    ],
  },
  2: {
    label: 'leftovers from earlier mail clients',
    expect: 'known-count',
    // The count each was measured at. A label that has grown since is one
    // nobody decided about.
    paths: [
      ['Sent Messages', 3],
      ['Déplacement', 2],
      ['Deleted Messages', 629],
      ['Junk', 9],
      // Last, because the [Mailbox]/* children must go before their parent.
      ['[Mailbox]', 2],
    ],
  },
};

const args = process.argv.slice(2);
const lotArg = args[args.indexOf('--lot') + 1];
const EXECUTE = args.includes('--execute');
const lot = LOTS[lotArg];
if (lot === undefined) {
  console.error('usage: gmail-remove-labels.mjs --lot <1|2> [--execute]');
  process.exit(2);
}

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

console.log(`${USER} — lot ${lotArg}: ${lot.label}`);
console.log(EXECUTE ? 'EXECUTING\n' : 'dry run: nothing will change\n');

let removed = 0;
let skipped = 0;

try {
  const present = new Set((await imap.listMailboxes()).map((b) => b.path));
  const entries = lot.expect === 'empty' ? lot.paths.map((p) => [p, 0]) : lot.paths;

  for (const [path, expected] of entries) {
    if (!present.has(path)) {
      console.log(`  skip  ${path.padEnd(24)} not there`);
      skipped += 1;
      continue;
    }

    // Re-check now, not from the earlier survey. A label that has taken
    // messages since is one nobody agreed to remove.
    let count;
    try {
      await imap.open(path);
      count = (await imap.searchFrom(path, 1)).length;
    } catch {
      console.log(`  skip  ${path.padEnd(24)} not selectable`);
      skipped += 1;
      continue;
    }

    if (count !== expected) {
      console.log(`  SKIP  ${path.padEnd(24)} holds ${count}, expected ${expected} — changed since it was surveyed`);
      skipped += 1;
      continue;
    }

    if (!EXECUTE) {
      console.log(`  would remove  ${path.padEnd(24)} ${count} message(s), all kept in All Mail`);
      continue;
    }
    await imap.deleteMailbox(path);
    console.log(`  removed  ${path.padEnd(24)} ${count} message(s) kept`);
    removed += 1;
  }
} finally {
  await imap.close();
}

console.log(
  EXECUTE
    ? `\n${removed} label(s) removed, ${skipped} skipped. No message was deleted.`
    : `\nDry run. Re-run with --execute to apply. ${skipped} would be skipped.`,
);
