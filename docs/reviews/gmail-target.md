# Gmail, the third Phase 1 target

Authorized and reachable. `ImapFlowConnection`'s access-token path had existed
since the wire client was written and had never met a server that speaks it —
the LINAGORA account advertises `AUTH=PLAIN` only — so this is the first time
XOAUTH2 has been exercised at all.

```
michel.maudet@gmail.com: 37 mailboxes
  \Inbox     INBOX
  \Flagged   [Gmail]/Suivis
  \Sent      [Gmail]/Messages envoyés
  \Drafts    [Gmail]/Brouillons
  \All       [Gmail]/Tous les messages
  \Junk      [Gmail]/Spam
  \Trash     [Gmail]/Corbeille
INBOX uidValidity=3 uidNext=176141
```

Read-only throughout: `LIST` and `EXAMINE`, nothing written, marked seen, moved
or flagged. This is the owner's own mailbox rather than a throwaway, so the
discipline is the same one the LINAGORA account gets — every destructive test
stays on the Dovecot container.

## What differs, in the order it will bite

### There is no archive folder

Gmail reports `\All` on `[Gmail]/Tous les messages` and no `\Archive` at all.
`toFolderRole` maps `\All` to `null`, which is right — inventing `archive` for
it would be worse — but it means **`role: 'archive'` resolves to nothing on
Gmail**.

That matters for Phase 3: PRD section 4.5 archives transactional mail to
`Archives/Transactions/` after a day. On Gmail, archiving is not a move at all
— it is removing the `INBOX` label, after which the message is in All Mail by
definition. A `moveMessage` that creates `Archives/Transactions/` would produce
a Gmail *label* nobody asked for, alongside the archive semantics Gmail already
has.

### Folder names are localised

`[Gmail]/Messages envoyés`, `[Gmail]/Brouillons`, `[Gmail]/Corbeille`. Any code
that finds Sent or Drafts by name is wrong on this account, and would be wrong
differently for a German or Japanese owner. The adapter resolves roles from
`SPECIAL-USE`, which is why it works here — and it is worth stating that the
alternative was never viable rather than merely inelegant.

### A message is in several folders at once

`[Gmail]/Tous les messages` contains everything the inbox contains. A poll that
walks folders sees each message once per label it carries, and the `folder`
field on `MailMessage` stops being a single answer.

Not a problem for classification, which works from the message. A real one for
Phase 3, where "move to X" means "add label X and remove label INBOX", and for
any cursor kept per folder.

### Old labels linger

`[Mailbox]/Later`, `[Mailbox]/To Buy`, `[Mailbox]/To Read`, `[Mailbox]/To Watch`
— an app discontinued in 2015. Thirty-seven folders where the container has
three. A folder listing on a real account is not a short list, and any per-folder
round trip is thirty-seven of them.

## What is not done

The Gmail-specific behaviour above is deliberately not implemented. The
authorization flow and the read path work; `moveMessage` and `setKeywords`
against Gmail belong with Phase 3, where the label semantics can be decided
once rather than guessed at twice.

`X-GM-EXT-1` — Gmail's thread ids, labels and search extension — is unused. It
would give `threadNative` on IMAP, which the adapter currently reports false
for.
