/**
 * How to address the person being answered.
 *
 * The style profile says the owner opens with "Bonjour," and nothing more,
 * because 71 of their 148 greetings carry a name and the profile's threshold
 * for "a habit" is half. Forty-eight percent is not a habit, and a global
 * habit was the wrong thing to look for: their real replies open "Bonjour
 * Tomasz," and "Bonjour Christelle," to people who wrote to them by name, and
 * "Bonjour," to people who did not.
 *
 * So this is not learned from the owner at all. It is read off the message
 * being answered, one message at a time: how the correspondent opened, and
 * whether they used tu or vous. A reply that mirrors both reads like a reply;
 * one that guesses reads like a form letter.
 */

import type { MailMessage } from '../types.js';
import { unquoted } from './language.js';

/** French second person. `null` when the message gives no evidence either way. */
export type Register = 'tu' | 'vous';

const GREETING = /^\s*(bonjour|bonsoir|salut|hello|hi|dear|cher|chère|chers)\b[^\n]{0,60}/i;

/**
 * Where the greeting ends.
 *
 * A body puts it on its own line; a preview runs the whole message together on
 * one, so the line is not the boundary. The comma is, when there is one — and
 * a full stop otherwise, unless it belongs to a title: "Bonjour M. Forest,"
 * ends at the comma, not after "M.".
 */
function trimGreeting(line: string): string {
  const comma = line.indexOf(',');
  if (comma !== -1) return line.slice(0, comma + 1);
  const stop = /(?<!\b[A-Z])\.(?=\s|$)/.exec(line);
  if (stop !== null) return line.slice(0, stop.index + 1);
  return line.slice(0, 45).trimEnd();
}

const TU = /\b(tu|te|toi|ton|ta|tes|t'(?:ai|as|es|avez)?)\b/gi;
const VOUS = /\b(vous|votre|vos)\b/gi;

/**
 * The line the correspondent opened with, verbatim.
 *
 * Verbatim because the useful part is everything the profile throws away:
 * whether they wrote a first name, a surname, "M.", or nothing. A reply can
 * mirror a line it has been shown; it cannot mirror a summary of one.
 */
export function greetingOf(message: MailMessage): string | null {
  const body = unquoted(message.bodyText ?? message.preview);
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue;
    const match = GREETING.exec(line);
    return match === null ? null : trimGreeting(match[0].trim());
  }
  return null;
}

/**
 * Whether the correspondent used tu or vous, or gave nothing to go on.
 *
 * Counted over what they wrote and not over the thread they quoted: a formal
 * exchange forwarded into a familiar one is the commonest way to get this
 * backwards.
 */
export function registerOf(message: MailMessage): Register | null {
  const body = unquoted(message.bodyText ?? message.preview);
  const tu = (body.match(TU) ?? []).length;
  const vous = (body.match(VOUS) ?? []).length;
  if (tu === 0 && vous === 0) return null;
  if (tu === vous) return null;
  return tu > vous ? 'tu' : 'vous';
}

/** The two facts, as the prompt states them. `null` when there are none. */
export function describeRegister(message: MailMessage): string | null {
  const greeting = greetingOf(message);
  const register = registerOf(message);
  if (greeting === null && register === null) return null;
  const lines: string[] = [];
  if (greeting !== null) {
    lines.push(
      `They opened with "${greeting}". Open the reply the same way, naming them` +
        ' if they named you and staying formal if they were formal.',
    );
  }
  if (register !== null) {
    lines.push(
      register === 'tu'
        ? 'They address the owner as "tu". Answer in the same register.'
        : 'They address the owner as "vous". Answer in the same register.',
    );
  }
  return lines.join('\n');
}
