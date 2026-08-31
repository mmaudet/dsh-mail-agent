/**
 * Which language a reply has to be written in.
 *
 * The drafting prompt has always carried a rule about it — *answer in the
 * language the message is written in* — and on thirteen real drafts written
 * from the owner's own instructions, one model broke it once and the other
 * twice. Both times the incoming message was English and the reply came back
 * in French.
 *
 * The cause is structural rather than a matter of emphasis. The owner writes
 * their instruction in their own language whatever the correspondent's, and
 * that instruction is the last thing the model reads before it writes. A rule
 * competing with a French sentence immediately above the answer loses.
 *
 * So the language stops being a rule the model applies and becomes a fact the
 * prompt states. Detection is deliberately narrow: the two languages this
 * mailbox actually contains, and `null` — meaning *fall back to the rule* —
 * for anything else, because a confident wrong answer here is worse than none.
 */

/** The languages this detector will commit to. */
export type ReplyLanguage = 'fr' | 'en';

const NAMES: Readonly<Record<ReplyLanguage, string>> = { fr: 'French', en: 'English' };

/**
 * Function words, not content words.
 *
 * Content words cross languages constantly in this corpus — "collaboration",
 * "notification", every product name — while function words do not, and a
 * count over two sets is steadier than any single marker.
 */
const MARKERS: Readonly<Record<ReplyLanguage, RegExp>> = {
  fr: /\b(le|la|les|des|une|nous|vous|est|sont|pour|dans|que|qui|avec|sur|par|votre|notre|bonjour|cordialement|merci|je|au|aux|du|ce|cette|nos|vos|bien|tout|plus)\b/gi,
  en: /\b(the|and|for|with|this|that|your|our|are|is|will|would|we|you|from|have|has|thanks|regards|hello|dear|please|to|of|in|on|it|be|as)\b/gi,
};

/** How much of a message is read. The opening carries the language. */
export const SAMPLE_CHARS = 1500;

/**
 * Where a quoted thread starts, in the forms this mailbox produces.
 *
 * Threads here accumulate for weeks, so the quoted part is usually longer than
 * the message — and often in the other language, because a French answer sits
 * above pages of forwarded English. Sampling the top of the raw body reads the
 * thread rather than the message, which the test for this found before any
 * mailbox did.
 */
const QUOTE_MARKER =
  /^\s*(>|-{2,}\s*(Message d'origine|Forwarded message|Original Message)|De\s*:|From\s*:|Le .{0,40}a écrit\s*:|On .{0,60}wrote\s*:|_{5,})/im;

/** The part the correspondent actually wrote, above anything they quoted. */
export function unquoted(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (QUOTE_MARKER.test(line)) break;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/**
 * The language of a piece of text, or `null` when it is not clear enough.
 *
 * `null` on a tie, on too little evidence, and on anything that is neither —
 * all three are the same answer to the caller: say nothing and let the general
 * rule stand.
 */
export function detectLanguage(text: string): ReplyLanguage | null {
  const own = unquoted(text);
  // An empty top means the whole message is a forward with no covering note;
  // then the thread is all there is to read.
  const sample = (own === '' ? text : own).slice(0, SAMPLE_CHARS);
  const fr = (sample.match(MARKERS.fr) ?? []).length;
  const en = (sample.match(MARKERS.en) ?? []).length;
  // Three markers is roughly one short sentence. Below that a signature block
  // or a one-line forward decides the language of a whole reply.
  if (Math.max(fr, en) < 3) return null;
  if (fr === en) return null;
  return fr > en ? 'fr' : 'en';
}

/** The language's English name, for a prompt that is written in English. */
export function languageName(language: ReplyLanguage): string {
  return NAMES[language];
}
