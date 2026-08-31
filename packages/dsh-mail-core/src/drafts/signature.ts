/**
 * The owner's signature, read from where they already keep it.
 *
 * A copy in the agent's own configuration would be a second source of the
 * owner's phone number, and the day they change it in their mail client the
 * agent would go on signing with the old one, silently. The server already
 * holds it: `Identity/get` (RFC 8621 section 6) returns `textSignature` and
 * `htmlSignature` for every identity, and that is what their other clients
 * read.
 *
 * On this account `textSignature` is empty and `htmlSignature` carries
 * everything, so the plain-text form has to be derived. That is the whole job
 * of this module.
 */

/** What `Identity/get` returns, narrowed to the parts a signature needs. */
export interface SignatureSource {
  readonly textSignature?: string | undefined;
  readonly htmlSignature?: string | undefined;
}

/**
 * The separator clients fold a signature at.
 *
 * Two dashes, a space, then the line break — RFC 3676 section 4.3. Written
 * without the trailing space, as this owner's HTML has it, a client treats it
 * as ordinary text and quotes the whole block back on every reply.
 */
export const SEPARATOR = '-- ';

const ENTITIES: Readonly<Record<string, string>> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/** Plain text out of the signature markup a mail client stores. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&[a-z]+;|&#39;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The signature to put under a draft, or `null` when the identity has none.
 *
 * `textSignature` wins when it is set — it is what the owner typed for plain
 * text — and the HTML is only a fallback.
 */
export function signatureOf(identity: SignatureSource): string | null {
  const text = (identity.textSignature ?? '').trim();
  const derived = text === '' ? htmlToText(identity.htmlSignature ?? '') : text;
  if (derived === '') return null;
  // A signature that already carries a separator keeps its own placement;
  // otherwise one is added, because without it every reply in the thread
  // quotes the whole block back.
  return /^--\s*$/m.test(derived) ? withProperSeparator(derived) : `${SEPARATOR}\n${derived}`;
}

/** Normalises a bare `--` to the `-- ` the RFC specifies. */
function withProperSeparator(signature: string): string {
  return signature
    .split('\n')
    .map((line) => (/^--\s*$/.test(line) ? SEPARATOR : line))
    .join('\n');
}

/**
 * The full body of a reply: what the owner says, their signature, then the
 * message being answered.
 *
 * The signature goes above the quote, where a mail client puts it, so that a
 * correspondent reading the reply sees who wrote it before they see what it
 * answers.
 */
export function withSignature(reply: string, signature: string | null): string {
  if (signature === null) return reply.trimEnd();
  return `${reply.trimEnd()}\n\n${signature}`;
}
