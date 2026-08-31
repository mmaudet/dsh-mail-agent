// Does a one-line intention turn an empty draft into the owner's reply?
//
//   node scripts/measure-draft-intent.mjs --limit 8 --accept-third-party
//
// The owner's observation, and it reframes the whole problem: when they hand a
// foundation model the message body and one line saying what they want to say,
// it writes something nearly complete. The drafts measured here produced an
// acknowledgement of receipt eight times out of eight — because an
// acknowledgement is the only reply that needs no intention, and the prompt
// supplied none.
//
// The test: take the intention out of what they actually wrote, phrase it as
// the five words they would have typed, hand the model that, and see whether
// the reply comes back.
//
// The circularity is real and bounded. Extracting an intention from the reply
// and then checking the draft matches that reply would prove nothing on its
// own. What it does test is the mechanism — whether a *short* instruction is
// enough to produce a *complete* message in the owner's voice — which is the
// claim being made. Who supplies the intention is not in question: the owner
// does, in five words, which is what they already do by hand.
//
// PERIMETER: sends the owner's sent mail to a third-party model.

import {
  JmapAdapter,
  learnStyle,
  describeStyle,
  ownWords,
  cleanDraft,
  DRAFT_SYSTEM_PROMPT,
} from '../packages/dsh-mail-core/dist/index.js';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const LIMIT = Number(arg('limit', '8'));
const MODEL = arg('model', 'mistralai/mistral-small-3.2-24b-instruct');
const BASE = 'https://openrouter.ai/api/v1';
if (!args.includes('--accept-third-party')) {
  console.error('Refusing: this sends the owner\'s sent mail to a third party.');
  process.exit(2);
}
const KEY = process.env.OPENROUTER_API_KEY;

const ACC = process.env.MAIL_SENTINEL_JMAP_ACCOUNT_ID;
const bearer = JSON.parse(process.env.MAIL_SENTINEL_JMAP_TOKENS).accessToken;
let apiUrl = null;
async function jmap(using, methodCalls) {
  if (!apiUrl) {
    const s = await fetch(process.env.MAIL_SENTINEL_JMAP_SESSION_URL, { headers: { authorization: `Bearer ${bearer}` } });
    if (!s.ok) throw new Error(`session ${s.status}`);
    apiUrl = (await s.json()).apiUrl;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ using, methodCalls }),
    });
    if (r.ok) return r.json();
    if (r.status < 500 && r.status !== 499 && r.status !== 429) {
      throw new Error(`JMAP ${r.status}: ${(await r.text()).slice(0, 80)}`);
    }
    await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
  }
  throw new Error('JMAP kept refusing');
}
const adapter = new JmapAdapter({ transport: { request: (b) => jmap(b.using, b.methodCalls) }, accountId: ACC, identityId: 'x' });

async function ask(system, user, temperature = 0.3) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL, temperature, max_tokens: 800,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    if (r.ok) return (await r.json()).choices?.[0]?.message?.content ?? '';
    if (r.status !== 429 && r.status < 500) throw new Error(String(r.status));
    await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
  }
  throw new Error('gave up');
}

const style = learnStyle(
  await adapter.getMessages(await adapter.messagesSince('Sent', new Date('2026-08-01'), 200)),
  { examples: 3 },
);
if (style === null) { console.error('too few replies'); process.exit(2); }

const sent = (await adapter.getMessages(await adapter.messagesSince('Sent', new Date('2026-08-24'), 200)))
  .filter((m) => m.inReplyTo.length > 0);
const inbox = await adapter.getMessages(await adapter.messagesSince('INBOX', new Date('2026-08-17'), 900));
const byMessageId = new Map(inbox.map((m) => [m.messageId, m]));

const pairs = [];
for (const reply of sent) {
  const original = reply.inReplyTo.map((id) => byMessageId.get(id)).find(Boolean);
  const theirs = original === undefined ? '' : ownWords(reply);
  if (original === undefined || theirs.length < 20) continue;
  pairs.push({ original, theirs });
  if (pairs.length >= LIMIT) break;
}

// The instruction the owner would have typed, not a summary of what they sent.
// An earlier version of this asked for something "telegraphic, no sentence
// structure", and got keyword soup — "37 rue Pierre POLI Issy 9h Valérie
// STEFFEN" — which no person would type and which the drafting model simply
// pasted back. The instruction has to look like what somebody actually types.
const INTENT_PROMPT = [
  'Below is a reply somebody sent. Recover the note they would have typed to',
  'have an assistant write it for them.',
  '',
  'Write it as a person in a hurry writes: short sentence fragments, their own',
  'language, no greeting and no sign-off, no politeness formulas. Something',
  'like "ok pour 9h, lieu 37 rue Pierre Poli, demander Valérie à l\'accueil".',
  '',
  'Keep every decision and fact only they could supply — a time, a place, a',
  'name, a yes, a no, an opinion. Drop everything that is form rather than',
  'content: the greeting, the pleasantries, the sign-off.',
  '',
  'Keep it under 40 words. Answer with the note and nothing else.',
].join('\n');

const withIntent = (message, intent) => [
  describeStyle(style),
  '',
  '---',
  '',
  'The owner has told you what they want to say. Write it as a message, in',
  'their voice and at their usual length.',
  '',
  'Their note is the content and all of it: say everything in it, add no fact',
  'that is not, and never copy it across as a list. It is shorthand for a',
  'message, not the message.',
  '',
  'Match the register of the message you are answering: if it uses "tu", so do',
  'you.',
  '',
  `WHAT THEY WANT TO SAY: ${intent}`,
  '',
  '--- the message being answered ---',
  `From: ${message.from[0]?.name ?? ''} <${message.from[0]?.email ?? ''}>`,
  `Subject: ${message.subject}`,
  '',
  (message.bodyText ?? message.preview).slice(0, 3000),
].join('\n');

const words = (t) => t.split(/\s+/).filter(Boolean).length;
const ACK = /(je vais|nous allons|je reviens vers|i will (get back|review|look)|je (l'|les )?examine|dès que possible)/i;

const rows = [];
for (const { original, theirs } of pairs) {
  const intent = (await ask(INTENT_PROMPT, theirs, 0)).trim().replace(/^["']|["']$/g, '');
  const draft = cleanDraft(await ask(DRAFT_SYSTEM_PROMPT, withIntent(original, intent)));
  rows.push({ theirs, intent, draft, subject: original.subject });

  console.log('-'.repeat(70));
  console.log(original.subject.slice(0, 62));
  console.log(`\n  THE INSTRUCTION (${words(intent)} words)\n    ${intent}`);
  console.log(`\n  THEY WROTE (${words(theirs)})`);
  console.log(theirs.split('\n').map((l) => '    ' + l).join('\n').slice(0, 500));
  console.log(`\n  FROM THE INSTRUCTION (${words(draft)})`);
  console.log(draft.split('\n').map((l) => '    ' + l).join('\n').slice(0, 500));
  console.log('');
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
console.log('='.repeat(70));
console.log(`\n  pairs                         ${rows.length}`);
console.log(`  median words, the instruction ${median(rows.map((r) => words(r.intent)))}`);
console.log(`  median words, theirs          ${median(rows.map((r) => words(r.theirs)))}`);
console.log(`  median words, from intent     ${median(rows.map((r) => words(r.draft)))}`);
console.log(`\n  "I'll get back to you"        ${rows.filter((r) => ACK.test(r.draft)).length}/${rows.length}  (was 8/8 without an intention)`);
console.log(`  signed "${style.signOff}"          ${rows.filter((r) => r.draft.includes(style.signOff)).length}/${rows.length}`);
