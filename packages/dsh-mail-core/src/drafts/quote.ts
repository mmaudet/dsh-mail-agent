/**
 * The thread, quoted under the reply.
 *
 * A draft the owner opens in their client has to look like a reply they
 * started there: their text, then the attribution line, then the message being
 * answered, prefixed. Without it they are reading their own answer with no
 * idea what it answers, and whoever receives it loses the thread in a client
 * that does not thread.
 *
 * This is content, not transport, so it belongs here rather than in the JMAP
 * adapter: `DraftMessage.bodyText` is what gets stored, and it should already
 * be the whole body.
 */

import type { MailMessage } from '../types.js';
import type { ReplyLanguage } from './language.js';

/** How deep a quoted thread is carried before it is cut. */
export const MAX_QUOTED_CHARS = 4000;

const MONTHS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];
const MONTHS_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad = (n: number): string => (n < 10 ? `0${String(n)}` : String(n));

/**
 * The line above the quote, in the language the reply is written in.
 *
 * Both forms are the ones the owner's own clients produce, so a reply drafted
 * here reads like the rest of the thread rather than like a machine's.
 */
export function attribution(message: MailMessage, language: ReplyLanguage): string {
  const from = message.from[0];
  const who = from === undefined ? '' : (from.name ?? from.email);
  const at = message.sentAt ?? message.receivedAt;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return language === 'en'
    ? `On ${String(at.getDate())} ${MONTHS_EN[at.getMonth()] ?? ''} ${String(at.getFullYear())} at ${time}, ${who} wrote:`
    : `Le ${String(at.getDate())} ${MONTHS_FR[at.getMonth()] ?? ''} ${String(at.getFullYear())} à ${time}, ${who} a écrit :`;
}

/** The message body, every line prefixed, as a reply quotes it. */
export function quoted(message: MailMessage): string {
  const body = (message.bodyText ?? message.preview).replace(/\r/g, '').trimEnd();
  const cut = body.length > MAX_QUOTED_CHARS ? `${body.slice(0, MAX_QUOTED_CHARS)}\n[…]` : body;
  return cut
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * The complete body of a reply: what the owner says, then what they answer.
 *
 * Their text is never touched — a draft whose signature moved is a draft they
 * have to read twice.
 */
export function withQuotedThread(
  reply: string,
  message: MailMessage,
  language: ReplyLanguage,
): string {
  return `${reply.trimEnd()}\n\n${attribution(message, language)}\n${quoted(message)}\n`;
}
