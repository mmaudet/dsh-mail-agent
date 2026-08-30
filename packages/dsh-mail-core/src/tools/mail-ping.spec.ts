import { describe, expect, it } from 'vitest';

import type { Capabilities } from '../types.js';
import { adapterKind, inject, name } from './mail-ping.js';

const JMAP: Capabilities = {
  push: 'jmap-push-subscription',
  customKeywords: true,
  threadNative: true,
  spamHeaders: true,
  stableIds: true,
};

const IMAP: Capabilities = {
  push: 'imap-idle',
  customKeywords: false,
  threadNative: false,
  spamHeaders: true,
  stableIds: true,
};

describe('the plugin declaration', () => {
  it('waits for both the tool registry and the mailbox service', () => {
    expect(name).toBe('mail-ping');
    expect(inject).toStrictEqual(['tools', 'mailbox']);
  });
});

describe('adapterKind', () => {
  it('reads the adapter off the capability set rather than a separate field', () => {
    expect(adapterKind(JMAP)).toBe('jmap');
    expect(adapterKind(IMAP)).toBe('imap');
  });
});
