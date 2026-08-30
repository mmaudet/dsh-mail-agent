// How much recurrence is there in this mailbox, at all?
//
// Node 3 can only ever settle a message whose source it has seen enough times
// to have learned. That ceiling is a property of the mailbox, not of the
// classifier — and it costs nothing to measure: headers only, no bodies, no
// model calls.
//
// The holdout runs kept measuring a window too short for the thing being
// measured. At 200 messages a day, a hundred messages is half a day, and a
// weekly newsletter cannot appear in both halves of it.
//
//   node scripts/probe-recurrence.mjs [--limit 3000] [--min 3]
//
// Read-only: Email/query and Email/get for four header properties.

const ACC = process.env.MAIL_SENTINEL_JMAP_ACCOUNT_ID;
const bearer = JSON.parse(process.env.MAIL_SENTINEL_JMAP_TOKENS).accessToken;

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return Number(i === -1 ? d : args[i + 1]);
};
const LIMIT = flag('limit', 3000);
const MIN = flag('min', 3);

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
  const body = await r.json();
  const [name, value] = body.methodResponses[0];
  if (name === 'error') throw new Error(`JMAP error: ${value.type}`);
  return value;
}

const boxes = await jmap([['Mailbox/get', { accountId: ACC, ids: null }, 'c']]);
const inbox = boxes.list.find((m) => m.role === 'inbox');

// Page the query: a mailbox is larger than any one response.
//
// James caps a response at 256 ids whatever `limit` says, and honours
// `position` correctly. Stopping when a page returns fewer than asked for is
// therefore wrong — it stops at 256 every time, on an inbox holding 32837.
const ids = [];
while (ids.length < LIMIT) {
  const page = await jmap([
    ['Email/query', {
      accountId: ACC,
      filter: { inMailbox: inbox.id },
      sort: [{ property: 'receivedAt', isAscending: false }],
      position: ids.length,
      limit: Math.min(500, LIMIT - ids.length),
    }, 'q'],
  ]);
  if (page.ids.length === 0) break;
  ids.push(...page.ids);
}

// Headers only. A body would be a hundred times the bytes for nothing.
const messages = [];
for (let from = 0; from < ids.length; from += 200) {
  const got = await jmap([
    ['Email/get', {
      accountId: ACC,
      ids: ids.slice(from, from + 200),
      properties: ['id', 'from', 'receivedAt', 'header:list-id:asText'],
    }, 'g'],
  ]);
  messages.push(...got.list);
}

const listIdOf = (h) => {
  const m = /<([^>]+)>/.exec(h ?? '');
  return m?.[1]?.trim().toLowerCase() ?? null;
};

const bySource = new Map();
for (const m of messages) {
  const listId = listIdOf(m['header:list-id:asText']);
  const key = listId !== null ? `list:${listId}` : `from:${(m.from?.[0]?.email ?? '').toLowerCase()}`;
  const day = (m.receivedAt ?? '').slice(0, 10);
  const bucket = bySource.get(key) ?? { count: 0, days: new Set() };
  bucket.count += 1;
  if (day) bucket.days.add(day);
  bySource.set(key, bucket);
}

const sources = [...bySource.entries()].sort((a, b) => b[1].count - a[1].count);
const recurring = sources.filter(([, v]) => v.count >= MIN);
const covered = recurring.reduce((n, [, v]) => n + v.count, 0);
const spanDays = new Set(messages.map((m) => (m.receivedAt ?? '').slice(0, 10))).size;

console.log(`${messages.length} messages over ${spanDays} day(s), ${sources.length} distinct sources\n`);
console.log(`sources seen ${MIN}+ times : ${recurring.length}`);
console.log(`messages they account for  : ${covered} (${((covered / messages.length) * 100).toFixed(0)}%)`);
console.log(`  ↑ the ceiling on what node 3 could ever settle, at min=${MIN}\n`);

console.log('top sources:');
for (const [key, v] of sources.slice(0, 20)) {
  console.log(`  ${String(v.count).padStart(4)}  over ${String(v.days.size).padStart(2)}d  ${key.slice(0, 62)}`);
}

// A source seen many times on one day is a burst, not a habit: it will not be
// there tomorrow, and a pattern learned from it settles nothing later.
const multiDay = recurring.filter(([, v]) => v.days.size >= 2);
const multiDayCovered = multiDay.reduce((n, [, v]) => n + v.count, 0);
console.log(`\nof those, recurring across 2+ days : ${multiDay.length} sources, ${multiDayCovered} messages (${((multiDayCovered / messages.length) * 100).toFixed(0)}%)`);
console.log('  ↑ the honest ceiling: a burst on one day is not a habit.');
