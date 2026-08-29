// Is Email/changes usable where Email/queryChanges is not? Fetch a real state
// first, then ask for changes since it.
const SESSION = process.env.SESSION_URL ?? 'http://localhost:18080/jmap/session';
const AUTH = process.env.BEARER
  ? `Bearer ${process.env.BEARER}`
  : `Basic ${Buffer.from(`${process.env.JUSER ?? 'itest@example.test'}:${process.env.JPASS ?? 'itest-secret'}`).toString('base64')}`;

const s = await (await fetch(SESSION, { headers: { accept: 'application/json', authorization: AUTH } })).json();
const apiUrl = new URL(new URL(s.apiUrl).pathname, SESSION).toString();
const accountId = s.primaryAccounts?.['urn:ietf:params:jmap:mail'] ?? Object.keys(s.accounts ?? {})[0];

const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';

async function call(name, args) {
  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: AUTH },
    body: JSON.stringify({ using: [CORE, MAIL], methodCalls: [[name, args, 'c0']] }),
  });
  const body = await r.json();
  return body.methodResponses?.[0] ?? ['(none)', {}];
}

// Email/get with no ids returns the account's mail state.
const [, got] = await call('Email/get', { accountId, ids: [], properties: ['id'] });
const state = got.state;
console.log('Email state:', state);

const [n1, a1] = await call('Email/changes', { accountId, sinceState: state, maxChanges: 50 });
console.log('Email/changes since current state ->', n1 === 'error' ? `error: ${a1.type}` : 'ok');
if (n1 !== 'error') {
  console.log('   newState:', a1.newState, ' created:', a1.created?.length, ' updated:', a1.updated?.length, ' destroyed:', a1.destroyed?.length, ' hasMoreChanges:', a1.hasMoreChanges);
}

// And the mailbox-level feed, which the folder view would need.
const [, mboxGot] = await call('Mailbox/get', { accountId, ids: [] });
const [n2, a2] = await call('Mailbox/changes', { accountId, sinceState: mboxGot.state });
console.log('Mailbox/changes ->', n2 === 'error' ? `error: ${a2.type}` : 'ok');
