import { describe, expect, it } from 'vitest';

import {
  decodeCursor,
  encodeCursor,
  knownKeywords,
  sentinelKeyword,
  toMailCategory,
  type MailboxCursor,
} from './types.js';

describe('toMailCategory', () => {
  it('accepts every category the cascade can assign', () => {
    expect(toMailCategory('important')).toBe('important');
    expect(toMailCategory('newsletter-promo')).toBe('newsletter-promo');
    expect(toMailCategory('needs-review')).toBe('needs-review');
  });

  it('rejects anything else rather than widening the union', () => {
    expect(toMailCategory('newsletter')).toBeNull();
    expect(toMailCategory('IMPORTANT')).toBeNull();
    expect(toMailCategory('')).toBeNull();
  });
});

describe('sentinelKeyword', () => {
  it('carries the category in the keyword name', () => {
    expect(sentinelKeyword('important')).toBe('$twaky-important');
    expect(sentinelKeyword('spam-certain')).toBe('$twaky-spam-certain');
  });
});

describe('knownKeywords', () => {
  it('recovers system keywords case-insensitively', () => {
    expect(knownKeywords(['$Seen', '$FLAGGED'])).toStrictEqual(['$seen', '$flagged']);
  });

  it('recovers Sentinel tags', () => {
    expect(knownKeywords(['$twaky-newsletter-tech'])).toStrictEqual(['$twaky-newsletter-tech']);
  });

  it('drops keywords another client may have set', () => {
    expect(knownKeywords(['$mailmindr', 'nonjunk', '$twaky-nonsense'])).toStrictEqual([]);
  });

  it('keeps the known ones out of a mixed list', () => {
    expect(knownKeywords(['$seen', 'someone-elses-tag', '$twaky-important'])).toStrictEqual([
      '$seen',
      '$twaky-important',
    ]);
  });
});

describe('cursor encoding', () => {
  const cases: readonly MailboxCursor[] = [
    { kind: 'jmap', sinceState: 'abc123' },
    { kind: 'imap', uidValidity: 1, lastUid: 0 },
    { kind: 'imap', uidValidity: 4294967295, lastUid: 987654 },
  ];

  it('round-trips every cursor shape', () => {
    for (const cursor of cases) {
      expect(decodeCursor(encodeCursor(cursor))).toStrictEqual(cursor);
    }
  });

  it('keeps a JMAP state string opaque, colons included', () => {
    const cursor: MailboxCursor = { kind: 'jmap', sinceState: 'state:with:colons' };
    expect(decodeCursor(encodeCursor(cursor))).toStrictEqual(cursor);
  });

  it('rejects malformed input rather than guessing a position', () => {
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('jmap:')).toBeNull();
    expect(decodeCursor('imap:1')).toBeNull();
    expect(decodeCursor('imap:1:2:3')).toBeNull();
    expect(decodeCursor('imap:one:two')).toBeNull();
    expect(decodeCursor('imap:-1:2')).toBeNull();
    expect(decodeCursor('imap:1.5:2')).toBeNull();
    expect(decodeCursor('pop3:1')).toBeNull();
  });

  it('rejects an integer too large to compare safely', () => {
    expect(decodeCursor('imap:1:99999999999999999999')).toBeNull();
  });
});
