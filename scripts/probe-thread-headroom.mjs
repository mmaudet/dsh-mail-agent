// Is node 1's eight points a floor or a ceiling?
//
// The measurement replayed a 200-message window against a cold store, so every
// thread paid full price once before it could be inherited from. An agent with
// a month of history behind it inherits from threads that started before the
// window — and how much that is worth is a property of the mailbox, measurable
// from headers alone.
//
//   node scripts/probe-thread-headroom.mjs [--inbox 250] [--history 2000]
//
// Read-only: Email/query and Email/get for three properties. No model calls.

const ACC = process.env.MAIL_SENTINEL_JMAP_ACCOUNT_ID;
const bearer = JSON.parse(process.env.MAIL_SENTINEL_JMAP_TOKENS).accessToken;

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return Number(i === -1 ? d : args[i + 1]);
};
const INBOX_N = flag('inbox', 250);
const HISTORY_N = flag('history', 2000);

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
    body: JSON.stringify({
      using,
      methodCalls,
    }),
  });
  const body = await r.json();
  const [name, value] = body.methodResponses[0];
  if (name === 'error') throw new Error(`JMAP error: ${value.type}`);
  return value;
}

async function idsOf(filter, limit) {
  // James caps a query response at 256 ids whatever `limit` says, and honours
  // `position` correctly. Stopping when a page returns fewer than asked for is
  // therefore wrong: it stops at 256 every time. Stop when a page is empty.
  const ids = [];
  while (ids.length < limit) {
    const page = await jmap([
      ['Email/query', {
        accountId: ACC,
        ...(filter === null ? {} : { filter }),
        sort: [{ property: 'receivedAt', isAscending: false }],
        position: ids.length,
        limit: Math.min(500, limit - ids.length),
      }, 'q'],
    ]);
    if (page.ids.length === 0) break;
    ids.push(...page.ids);
  }
  return ids;
}

async function threadsOf(ids) {
  const out = [];
  for (let at = 0; at < ids.length; at += 200) {
    const got = await jmap([
      ['Email/get', {
        accountId: ACC,
        ids: ids.slice(at, at + 200),
        properties: ['id', 'threadId', 'receivedAt'],
      }, 'g'],
    ]);
    out.push(...got.list);
  }
  return out;
}

const boxes = await jmap([['Mailbox/get', { accountId: ACC, ids: null }, 'c']]);
const inbox = boxes.list.find((m) => m.role === 'inbox');

const inboxMessages = await threadsOf(await idsOf({ inMailbox: inbox.id }, INBOX_N));
// No mailbox filter: the whole account, which is where a thread's earlier
// messages live once the owner has filed them.
const history = await threadsOf(await idsOf(null, HISTORY_N));

console.log(`inbox window : ${inboxMessages.length} messages`);
console.log(`history      : ${history.length} messages across the account\n`);

const byThread = new Map();
for (const m of history) {
  const bucket = byThread.get(m.threadId) ?? [];
  bucket.push(m.receivedAt);
  byThread.set(m.threadId, bucket);
}

const inboxIds = new Set(inboxMessages.map((m) => m.id));

let withinWindow = 0;
let beyondWindow = 0;
let alone = 0;

for (const m of inboxMessages) {
  const siblings = (byThread.get(m.threadId) ?? []).length;
  if (siblings <= 1) {
    alone += 1;
    continue;
  }
  // Does the thread have a message the inbox window does not contain?
  const outside = (history.filter((h) => h.threadId === m.threadId) ?? []).some(
    (h) => !inboxIds.has(h.id) && h.receivedAt < m.receivedAt,
  );
  if (outside) beyondWindow += 1;
  else withinWindow += 1;
}

const pct = (n) => `${((n / inboxMessages.length) * 100).toFixed(0)}%`;
console.log(`  alone in their thread              : ${alone} (${pct(alone)})`);
console.log(`  thread has an earlier message      :`);
console.log(`    inside the inbox window          : ${withinWindow} (${pct(withinWindow)})`);
console.log(`    only outside it, already filed   : ${beyondWindow} (${pct(beyondWindow)})`);
console.log(
  `\n  ↑ the second line is what a cold store measured (8 points on 200 messages).`,
);
console.log(`  ↑ the third is the headroom a warm store adds, and nothing else can reach.`);
console.log('\nRead-only throughout.');
