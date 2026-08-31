// Put the approved replies in the owner's Drafts folder.
//
//   node scripts/deposit-drafts.mjs --in approved.json           # one, to check
//   node scripts/deposit-drafts.mjs --in approved.json --all     # the rest
//
// This writes to the live mailbox, so it does one first and stops: a draft the
// owner can open and inspect is worth more than a report saying thirteen were
// created. `--all` does the remainder, skipping anything already deposited.
//
// It is not a send. PRD section 4.4 keeps sending entirely with the owner, and
// nothing here reaches EmailSubmission — the drafts sit in their client until
// they press send.
//
// Recipients are the sender of the message being answered, and nobody else.
// Several of these threads carry long Cc lists and the owner's own replies
// sometimes keep them, but adding a recipient on their behalf is a decision
// about who hears from them, which is theirs to make in their client.

import { readFileSync, writeFileSync } from 'node:fs';

import {
  JmapAdapter,
  detectLanguage,
  withQuotedThread,
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
const LEDGER = arg('ledger', '/tmp/deposited.json');
const ALL = args.includes('--all');

if (IN === null) {
  console.error('usage: deposit-drafts.mjs --in approved.json [--all]');
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
  identityId: process.env.MAIL_SENTINEL_JMAP_IDENTITY_ID ?? 'x',
});

let done = {};
try {
  done = JSON.parse(readFileSync(LEDGER, 'utf8'));
} catch {
  done = {};
}

const approved = JSON.parse(readFileSync(IN, 'utf8')).filter(
  (r) => r.verdict === 'kept' && typeof r.text === 'string' && r.text.trim() !== '',
);
const originals = new Map((await adapter.getMessages(approved.map((r) => r.id))).map((m) => [m.id, m]));

const pending = approved.filter((r) => done[r.id] === undefined);
console.log(`${String(approved.length)} approved, ${String(pending.length)} not yet deposited`);
const batch = ALL ? pending : pending.slice(0, 1);
if (batch.length === 0) {
  console.log('nothing to do');
  process.exit(0);
}

for (const row of batch) {
  const original = originals.get(row.id);
  if (original === undefined) {
    console.error(`  skipped ${row.subject}: the message is no longer in the mailbox`);
    continue;
  }
  const sender = original.from[0];
  if (sender === undefined) {
    console.error(`  skipped ${row.subject}: no sender to reply to`);
    continue;
  }
  const subject = /^\s*(re|rép)\s*:/i.test(original.subject)
    ? original.subject
    : `Re: ${original.subject}`;
  // Oldest first, the original's own Message-ID last: that is the chain a
  // client threads on, and dropping it detaches the reply from the thread.
  const references =
    original.messageId === null
      ? original.references
      : [...original.references, original.messageId];

  // The owner reads their answer against what it answers, and so does whoever
  // receives it in a client that does not thread.
  const language = detectLanguage(original.bodyText ?? original.preview) ?? 'fr';
  const id = await adapter.createDraft({
    to: [sender],
    cc: [],
    subject,
    bodyText: withQuotedThread(row.text, original, language),
    inReplyTo: original.messageId,
    references,
  });
  done[row.id] = { draftId: id, subject, to: sender.email, at: new Date().toISOString() };
  console.log(`  deposited  ${id}  ->  ${sender.email}  ${subject.slice(0, 52)}`);
}

writeFileSync(LEDGER, JSON.stringify(done, null, 2));
console.log(`\nledger: ${LEDGER} (${String(Object.keys(done).length)} deposited in all)`);
if (!ALL && pending.length > 1) {
  console.log(`Open it in your client. ${String(pending.length - 1)} more with --all.`);
}
