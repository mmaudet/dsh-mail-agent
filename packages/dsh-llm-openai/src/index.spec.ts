import { describe, expect, it } from 'vitest';

import { BUNDLE_ID } from './index.js';

describe('@dsh-mail-agent/llm-openai', () => {
  it('declares its bundle id', () => {
    expect(BUNDLE_ID).toBe('@dsh-mail-agent/llm-openai');
  });
});
