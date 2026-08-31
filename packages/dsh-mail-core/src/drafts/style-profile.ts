/**
 * What the owner's own replies say about how they write (PRD section 5).
 *
 * Deliberately small and deliberately legible. A profile the owner cannot read
 * is one they cannot correct, and every field here is a claim they can check
 * against their own Sent folder in a second: how long their replies run, how
 * they open one, how they sign off.
 *
 * What it is not: a tone vector, a persona, or an adjective. Those describe
 * writing without constraining it, and a model told to be "warm but
 * professional" writes what it was going to write anyway. `signOff:
 * 'Michel-Marie'` is a fact that changes the output.
 *
 * The statistics are half of it. The other half is `examples` — a handful of
 * the owner's actual replies, because three real sentences carry what no
 * description does.
 */

import type { MailMessage } from '../types.js';

export interface StyleProfile {
  /** Words in a typical reply, and the quarter-point below it. */
  readonly medianWords: number;
  readonly shortWords: number;
  /** How replies open, most frequent first, at most a handful. */
  readonly openings: readonly string[];
  /** How they are signed off. */
  readonly signOff: string;
  /** Languages seen, most used first. A draft answers in the thread's. */
  readonly languages: readonly string[];
  /** True when openings usually carry the correspondent's first name. */
  readonly addressesByName: boolean;
  /**
   * Whole replies of the owner's, short ones first.
   *
   * These are the owner's own words going into a prompt. Nothing here is
   * summarised or paraphrased: a paraphrase of a voice is not that voice.
   */
  readonly examples: readonly string[];
  /** How many replies this was drawn from, so a thin profile is visible. */
  readonly sampledFrom: number;
}

/** Below this the profile is guessing, and says so by not existing. */
export const MIN_REPLIES = 10;

/**
 * Strips the quoted thread and the signature from a sent message.
 *
 * Everything below the first quote marker is the correspondent's words, not
 * the owner's; counting them makes every reply look long and makes the profile
 * describe the people writing in.
 */
export function ownWords(message: MailMessage): string {
  const body = message.bodyText ?? '';
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('>')) continue;
    // `-- ` is the RFC 3676 signature delimiter. The rest are the attributions
    // clients put above a quoted thread, in the two languages this mailbox
    // writes in, plus the rules and forwarded-header blocks that do the same
    // job. Found by reading what leaked through an earlier version: a court's
    // address in Graz, and half of somebody's footer.
    if (/^--\s*$/.test(line)) break;
    if (/\ba écrit\s*:\s*$/.test(trimmed)) break;
    if (/\bwrote:\s*$/.test(trimmed)) break;
    if (/^_{5,}|^-{5,}|^={5,}/.test(trimmed)) break;
    if (/^(De|From|Envoyé|Sent|To|À)\s*:/.test(trimmed)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** Rough language detection, on the words that differ most between the two. */
function languageOf(text: string): string {
  const french = /\b(le|la|les|des|une|vous|nous|est|pour|avec|bonjour|merci|cordialement)\b/gi;
  const english = /\b(the|and|you|are|for|with|hello|thanks|regards|please)\b/gi;
  const fr = (text.match(french) ?? []).length;
  const en = (text.match(english) ?? []).length;
  if (fr === 0 && en === 0) return 'unknown';
  return fr >= en ? 'fr' : 'en';
}

const FIRST_NAME = /^(bonjour|salut|hello|hi|bonsoir|cher|chère|dear)\s+[A-ZÀ-Ý][\wÀ-ÿ'-]+/i;
const GREETING = /^(bonjour|salut|hello|hi|bonsoir|cher|chère|dear)\b/i;

export interface LearnStyleOptions {
  /** How many whole replies to carry as examples. */
  readonly examples?: number | undefined;
  /** Longest example to carry, in words. */
  readonly exampleWords?: number | undefined;
}

/**
 * Derives a profile from sent messages, or `null` when there are too few.
 *
 * Replies only. An original message is not the shape of anything the agent
 * would draft, and including them stretches every length upward.
 */
export function learnStyle(
  sent: readonly MailMessage[],
  options: LearnStyleOptions = {},
): StyleProfile | null {
  const wanted = options.examples ?? 3;
  const exampleWords = options.exampleWords ?? 120;

  const replies = sent.filter((m) => m.inReplyTo.length > 0);
  const bodies = replies.map(ownWords).filter((b) => b.length > 0);
  if (bodies.length < MIN_REPLIES) return null;

  const counts = bodies.map(wordCount).sort((a, b) => a - b);
  const at = (q: number): number => counts[Math.min(counts.length - 1, Math.floor(counts.length * q))] ?? 0;

  const openings = new Map<string, number>();
  const signOffs = new Map<string, number>();
  const languages = new Map<string, number>();
  let named = 0;
  let greeted = 0;

  for (const body of bodies) {
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    const first = lines[0];
    const last = lines.at(-1);
    if (first !== undefined && GREETING.test(first)) {
      greeted += 1;
      if (FIRST_NAME.test(first)) named += 1;
      // The greeting without the name, so the profile carries a form to fill
      // rather than one correspondent's name repeated three times.
      const form = first.replace(FIRST_NAME, (m) => m.split(/\s+/)[0] ?? m).slice(0, 20);
      openings.set(form, (openings.get(form) ?? 0) + 1);
    }
    if (last !== undefined && last.length <= 40) {
      signOffs.set(last, (signOffs.get(last) ?? 0) + 1);
    }
    const lang = languageOf(body);
    if (lang !== 'unknown') languages.set(lang, (languages.get(lang) ?? 0) + 1);
  }

  const top = (m: Map<string, number>, n: number): string[] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

  // Complete replies, short ones first: a short reply shows the whole shape —
  // greeting, answer, sign-off — where a long one shows a subject the agent
  // will never be drafting about.
  const examples = bodies
    .filter((b) => wordCount(b) >= 5 && wordCount(b) <= exampleWords)
    .sort((a, b) => wordCount(a) - wordCount(b))
    .slice(0, wanted);

  return {
    medianWords: at(0.5),
    shortWords: at(0.25),
    openings: top(openings, 3),
    signOff: top(signOffs, 1)[0] ?? '',
    languages: top(languages, 2),
    // Half, not a majority: a greeting that names the correspondent half the
    // time is a habit worth imitating, and one that never does is a habit
    // worth not inventing.
    addressesByName: greeted > 0 && named / greeted >= 0.5,
    examples,
    sampledFrom: bodies.length,
  };
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** The profile as the owner would read it, and as the prompt states it. */
export interface DescribeStyleOptions {
  /**
   * Whether the draft signs itself.
   *
   * False when the owner's signature is appended from their mail account
   * afterwards: telling the model how they sign and then forbidding it to sign
   * is a contradiction the model resolves by signing.
   */
  readonly signs?: boolean | undefined;
}

export function describeStyle(profile: StyleProfile, options: DescribeStyleOptions = {}): string {
  const signs = options.signs ?? true;
  const lines = [
    `Replies run about ${String(profile.medianWords)} words; a quarter are ${String(profile.shortWords)} or fewer.`,
    `They open with ${profile.openings.map((o) => `"${o}"`).join(' or ')}` +
      (profile.addressesByName ? ", usually followed by the correspondent's first name." : '.'),
    signs ? `They are signed "${profile.signOff}".` : null,
    `They are written in ${profile.languages.join(' or ')}, matching the message being answered.`,
    `Drawn from ${String(profile.sampledFrom)} replies.`,
  ];
  if (profile.examples.length > 0) {
    lines.push('', 'Replies they actually sent:');
    for (const example of profile.examples) {
      lines.push('---', example);
    }
  }
  return lines.filter((line): line is string => line !== null).join('\n');
}
