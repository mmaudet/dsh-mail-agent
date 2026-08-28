import { describe, expect, it } from 'vitest';

import { BUNDLE_ID } from './index.js';

describe('@dsh-mail-agent/mail-digest', () => {
  it('declares its bundle id', () => {
    expect(BUNDLE_ID).toBe('@dsh-mail-agent/mail-digest');
  });
});
