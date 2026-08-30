// Does the classifier give one answer per source, or several?
//
// The IMAP twin, for comparing one kind of mailbox against another.
//
// The holdout runs blamed the window, then the granularity. The diagnostic said
// otherwise: of seven frequent sources that yielded no learned pattern, six
// failed because the model disagreed with itself — one support address came
// back under four categories across seven messages.
//
// That is the binding constraint, and it is measurable on its own. A cascade
// cannot cache an answer that is not stable enough to cache.
//
//   node scripts/probe-source-consistency.mjs [--limit 200] [--min 3]
//
// Read-only, and every model call goes to the sovereign gateway.

import { ImapFlowConnection } from '../packages/dsh-mail-core/dist/adapters/imap-client.js';
import { createLlmClassifier } from '../packages/dsh-mail-core/dist/cascade/llm-classifier.js';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return Number(i === -1 ? d : args[i + 1]);
};
const LIMIT = flag('limit', 200);
const MIN = flag('min', 3);

const API_BASE = process.env.MAIL_SENTINEL_API_BASE;
if (!/^https:\/\/chat\.lucie\.ovh\.linagora\.com\//.test(API_BASE ?? '')) {
  console.error(`Refusing to run: MAIL_SENTINEL_API_BASE is ${API_BASE}`);
  process.exit(2);
}
const llm = {
  async *stream(options) {
    const r = await fetch(`${API_BASE.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.MAIL_SENTINEL_API_KEY}`,
      },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        max_tokens: options.maxTokens ?? 256,
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.messages[0].content.map((b) => b.text).join('') },
        ],
      }),
    });
    if (!r.ok) throw new Error(`gateway ${r.status}`);
    const body = await r.json();
    yield { type: 'text-delta', index: 0, text: body.choices?.[0]?.message?.content ?? '' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};

const model = createLlmClassifier({
  llm,
  provider: 'mail-llm-economy',
  model: 'Mistral-Small-3.2-24B-Instruct-2506-FP8',
});
const context = {
  owner: process.env.MAIL_SENTINEL_OWNER ?? 'mmaudet@linagora.com',
  vipSenders: [],
  corporateDomains: ['linagora.com'],
  threadCategory: null,
  learnedPatterns: [],
};


const USER = process.env.MAIL_SENTINEL_GMAIL_USER;
const stored = process.env.MAIL_SENTINEL_GMAIL_TOKENS;
if (!USER || !stored) {
  console.error('MAIL_SENTINEL_GMAIL_USER and MAIL_SENTINEL_GMAIL_TOKENS must be set');
  process.exit(2);
}
const { accessToken, expiresAt } = JSON.parse(stored);
if (expiresAt && new Date(expiresAt) < new Date()) {
  console.error(`token expired at ${expiresAt} — run: mail-auth gmail refresh`);
  process.exit(2);
}
const fi = process.argv.indexOf('--folder');
const FOLDER = fi === -1 ? '[Gmail]/Tous les messages' : process.argv[fi + 1];

const imap = new ImapFlowConnection({
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  user: USER,
  accessToken,
});

const messages = [];
try {
  const status = await imap.open(FOLDER);
  const uids = (await imap.searchFrom(FOLDER, Math.max(1, status.uidNext - LIMIT))).slice(-LIMIT);
  for (let at = 0; at < uids.length; at += 50) {
    for (const m of await imap.fetchByUid(FOLDER, uids.slice(at, at + 50))) {
      const listId = /<([^>]+)>/.exec(m.headers['list-id'] ?? '')?.[1]?.trim().toLowerCase() ?? null;
      messages.push({
        id: String(m.uid),
        subject: m.envelope.subject ?? '',
        from: m.envelope.from,
        to: m.envelope.to,
        cc: m.envelope.cc,
        preview: (m.bodyText ?? '').slice(0, 256),
        bodyText: m.bodyText,
        bodyHtml: m.bodyHtml,
        hasAttachments: m.hasAttachments,
        listUnsubscribe: [],
        listId,
        threadId: null,
        messageId: m.envelope.messageId,
        inReplyTo: [],
        references: [],
        receivedAt: m.internalDate,
        sentAt: m.envelope.date,
        keywords: m.flags,
        folder: FOLDER,
        spamHeaders: {},
      });
    }
  }
} finally {
  await imap.close();
}

const bySource = new Map();
for (const m of messages) {
  const key = m.listId ? `list:${m.listId}` : `from:${(m.from[0]?.email ?? '').toLowerCase()}`;
  const bucket = bySource.get(key) ?? [];
  bucket.push(m);
  bySource.set(key, bucket);
}

const frequent = [...bySource.entries()]
  .filter(([, ms]) => ms.length >= MIN)
  .sort((a, b) => b[1].length - a[1].length);

console.log(`${messages.length} messages, ${frequent.length} source(s) seen ${MIN}+ times\n`);

let unanimous = 0;
let coveredByUnanimous = 0;
let classified = 0;

for (const [key, ms] of frequent) {
  const categories = new Map();
  for (const m of ms) {
    try {
      const v = await model.classify(m, context);
      categories.set(v.category, (categories.get(v.category) ?? 0) + 1);
      classified += 1;
    } catch {
      /* a malformed answer is not what this measures */
    }
  }
  const spread = [...categories.entries()].sort((a, b) => b[1] - a[1]);
  const agrees = spread.length === 1;
  if (agrees) {
    unanimous += 1;
    coveredByUnanimous += ms.length;
  }
  console.log(
    `${agrees ? ' ok ' : 'SPLIT'} ${String(ms.length).padStart(3)}  ${key.slice(0, 46).padEnd(46)} ${spread.map(([c, n]) => `${c}×${String(n)}`).join(' ')}`,
  );
}

const total = frequent.reduce((n, [, ms]) => n + ms.length, 0);
console.log(`\n  unanimous sources      : ${unanimous} of ${frequent.length}`);
console.log(`  messages they cover    : ${coveredByUnanimous} of ${messages.length} (${((coveredByUnanimous / messages.length) * 100).toFixed(0)}%)`);
console.log(`  ↑ what node 3 could actually learn, against a ceiling of ${((total / messages.length) * 100).toFixed(0)}%`);
console.log(`\n  ${classified} model calls. Read-only throughout.`);
