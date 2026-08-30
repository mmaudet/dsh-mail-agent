import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import {
  MailboxService,
  keywordFallback,
  planDegradedKeywords,
  type MailService,
} from './mail-service.js';
import type { Capabilities, MailChange, MailFolder, MailMessage } from './types.js';

type Call =
  | { readonly op: 'setKeywords'; readonly id: string; readonly keywords: readonly string[] }
  | { readonly op: 'moveMessage'; readonly id: string; readonly folder: string };

const JMAP_LIKE: Capabilities = {
  push: 'jmap-push-subscription',
  customKeywords: true,
  threadNative: true,
  spamHeaders: true,
};

const IMAP_LIKE: Capabilities = {
  push: 'imap-idle',
  customKeywords: false,
  threadNative: false,
  spamHeaders: true,
};

/** Records what the service asked of it; performs no I/O. */
class RecordingAdapter implements MailService {
  readonly calls: Call[] = [];

  constructor(readonly capabilities: Capabilities) {}

  listFolders(): Promise<MailFolder[]> {
    return Promise.resolve([]);
  }

  currentCursor(): Promise<string> {
    return Promise.resolve('cursor');
  }

  queryChanges(): Promise<MailChange[]> {
    return Promise.resolve([]);
  }

  getMessages(): Promise<MailMessage[]> {
    return Promise.resolve([]);
  }

  watchInbox(): AsyncDisposable {
    return { [Symbol.asyncDispose]: () => Promise.resolve() };
  }

  moveMessage(id: string, folder: string): Promise<void> {
    this.calls.push({ op: 'moveMessage', id, folder });
    return Promise.resolve();
  }

  setKeywords(id: string, keywords: string[]): Promise<void> {
    this.calls.push({ op: 'setKeywords', id, keywords: [...keywords] });
    return Promise.resolve();
  }

  createDraft(): Promise<string> {
    return Promise.resolve('draft-1');
  }

  submitDraft(): Promise<void> {
    return Promise.resolve();
  }
}

function mount(capabilities: Capabilities): {
  service: MailboxService;
  adapter: RecordingAdapter;
} {
  const adapter = new RecordingAdapter(capabilities);
  return { service: new MailboxService(new Context(), adapter), adapter };
}

describe('MailboxService registration', () => {
  it('registers itself on the context as mailbox', () => {
    const ctx = new Context();
    const service = new MailboxService(ctx, new RecordingAdapter(JMAP_LIKE));
    expect(service.name).toBe('mailbox');
  });

  it('exposes the mounted adapter capabilities unchanged', () => {
    const { service } = mount(IMAP_LIKE);
    expect(service.capabilities).toStrictEqual(IMAP_LIKE);
  });
});

describe('setKeywords on a server with custom keywords', () => {
  it('passes keywords straight through and moves nothing', async () => {
    const { service, adapter } = mount(JMAP_LIKE);
    await service.setKeywords('m1', ['$twaky-veille-newsletter', '$seen']);
    expect(adapter.calls).toStrictEqual([
      { op: 'setKeywords', id: 'm1', keywords: ['$twaky-veille-newsletter', '$seen'] },
    ]);
  });
});

describe('setKeywords on a server without custom keywords', () => {
  it('files a newsletter into its folder instead of tagging it', async () => {
    const { service, adapter } = mount(IMAP_LIKE);
    await service.setKeywords('m1', ['$twaky-veille-newsletter']);
    expect(adapter.calls).toStrictEqual([
      { op: 'moveMessage', id: 'm1', folder: 'Veille' },
    ]);
  });

  it('flags an important message in place rather than moving it', async () => {
    const { service, adapter } = mount(IMAP_LIKE);
    await service.setKeywords('m1', ['$twaky-demande-interne']);
    expect(adapter.calls).toStrictEqual([
      { op: 'setKeywords', id: 'm1', keywords: ['\\Flagged'] },
    ]);
  });

  it('does nothing at all for a category with no flag and no folder', async () => {
    // `rh-interne` concerns a named person and is usually short-lived, so it
    // stays in the inbox unmarked on a server that cannot tag.
    const { service, adapter } = mount(IMAP_LIKE);
    await service.setKeywords('m1', ['$twaky-rh-interne']);
    expect(adapter.calls).toStrictEqual([]);
  });

  it('files a receipt into the accounting folder', async () => {
    const { service, adapter } = mount(IMAP_LIKE);
    await service.setKeywords('m1', ['$twaky-recu-transaction']);
    expect(adapter.calls).toStrictEqual([
      { op: 'moveMessage', id: 'm1', folder: 'Archives/Comptabilite' },
    ]);
  });

  it('still stores standard IMAP flags the server does understand', async () => {
    const { service, adapter } = mount(IMAP_LIKE);
    await service.setKeywords('m1', ['$seen', '$twaky-phishing-arnaque']);
    expect(adapter.calls).toStrictEqual([
      { op: 'setKeywords', id: 'm1', keywords: ['$seen'] },
      { op: 'moveMessage', id: 'm1', folder: 'Junk' },
    ]);
  });
});

describe('planDegradedKeywords', () => {
  it('sends a message to one folder even when two categories name one', () => {
    expect(planDegradedKeywords(['$twaky-phishing-arnaque', '$twaky-veille-newsletter'])).toStrictEqual({
      flags: [],
      folder: 'Junk',
    });
  });

  it('matches Sentinel tags case-insensitively', () => {
    expect(planDegradedKeywords(['$TWAKY-DEMANDE-INTERNE'])).toStrictEqual({
      flags: ['\\Flagged'],
      folder: null,
    });
  });

  it('passes an unrecognised tag through rather than dropping it', () => {
    expect(planDegradedKeywords(['$twaky-nonsense'])).toStrictEqual({
      flags: ['$twaky-nonsense'],
      folder: null,
    });
  });
});

describe('keywordFallback', () => {
  it('marks needs-review with a folder, the only mark such a server allows', () => {
    expect(keywordFallback('needs-review')).toStrictEqual({ flags: [], folder: 'NeedsReview' });
  });
});
