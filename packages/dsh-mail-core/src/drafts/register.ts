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
 * being answered, one message at a time.
 *
 * The register — tu or vous — mirrors cleanly. The greeting does not, and the
 * first version of this got it wrong: a message opening "Bonjour M. Forest,"
 * produced "Bonjour Monsieur Rini,", because the correspondent had written to
 * a colleague who has since left and the reply copied the *shape* of a
 * greeting addressed to somebody else. The owner asked for "Bonjour,".
 *
 * Nor is it predictable from acquaintance. Over 900 sent messages they name a
 * first contact 63% of the time and someone they have written to before 40% —
 * the opposite of the obvious guess, and no signal either way. So the name is
 * carried only when the correspondent greeted *the owner* by name, which is
 * the one case where mirroring is a fact rather than an inference.
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

/**
 * Whether the greeting names the owner rather than a third party.
 *
 * The case that made this necessary: a message to a colleague who has left,
 * still opening with that colleague's surname, answered by the owner.
 */
export function greetsOwner(greeting: string, ownNames: readonly string[]): boolean {
  const words = greeting
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z-]{3,}/g);
  if (words === null || words.length < 2) return false;
  // Both halves of a compound name and the whole: "Michel-Marie" is greeted
  // as "Michel" about as often as in full.
  const parts = new Set(
    ownNames.flatMap((n) =>
      n
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .split(/[^a-z-]+/)
        .flatMap((w) => [w, ...w.split('-')])
        .filter((w) => w.length >= 3),
    ),
  );
  // The first word is the greeting itself; anything after it is the name.
  return words.slice(1).some((w) => w.split('-').some((part) => parts.has(part)) || parts.has(w));
}

/** The two facts, as the prompt states them. `null` when there are none. */
export function describeRegister(message: MailMessage, ownNames: readonly string[] = []): string | null {
  const greeting = greetingOf(message);
  const register = registerOf(message);
  if (greeting === null && register === null) return null;
  const lines: string[] = [];
  if (greeting !== null) {
    lines.push(
      greetsOwner(greeting, ownNames)
        ? `They opened with "${greeting}", naming the owner. Open the reply the` +
          ' same way, naming them back and matching how formal they were.'
        : `They opened with "${greeting}". Open with a bare greeting — "Bonjour,"` +
          ' — and do not name them: that line names somebody else, or nobody.',
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
