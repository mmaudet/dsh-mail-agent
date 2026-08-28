/**
 * Mail contract, adapters, auth and tools for the DSH mail agent.
 *
 * Consumers depend on the contract and the capability set, never on an
 * adapter: which one is mounted is a `cordis.patch.yml` decision.
 */

export const BUNDLE_ID = '@dsh-mail-agent/mail-core' as const;

export type BundleId = typeof BUNDLE_ID;

export {
  decodeCursor,
  encodeCursor,
  knownKeywords,
  sentinelKeyword,
  toMailCategory,
  type Capabilities,
  type DraftMessage,
  type Envelope,
  type FolderRole,
  type MailAddress,
  type MailCategory,
  type MailChange,
  type MailChangeKind,
  type MailFolder,
  type MailKeyword,
  type MailMessage,
  type MailboxCursor,
  type SentinelKeyword,
  type SystemKeyword,
} from './types.js';

export {
  MailboxService,
  keywordFallback,
  planDegradedKeywords,
  type KeywordFallback,
  type MailService,
} from './mail-service.js';

export {
  JMAP_CORE,
  JMAP_MAIL,
  JMAP_SUBMISSION,
  JmapAdapter,
  type JmapAdapterOptions,
  type JmapMethodCall,
  type JmapPushChannel,
  type JmapRequest,
  type JmapTransport,
} from './adapters/jmap-adapter.js';

export {
  ImapAdapter,
  RE_IDLE_INTERVAL_MS,
  messageId,
  parseMessageId,
  type ImapAdapterOptions,
  type ImapConnection,
  type ImapFetchedMessage,
  type ImapMailbox,
  type MailboxStatus,
  type OutgoingMessage,
  type SmtpSender,
} from './adapters/imap-adapter.js';

export {
  EXPIRY_SKEW_MS,
  TokenStore,
  isExpired,
  redact,
  type SecretStore,
  type StoredTokens,
} from './auth/token-store.js';

export {
  OidcClient,
  createPkcePair,
  createState,
  type AuthorizationRequest,
  type HttpClient,
  type OidcConfig,
  type OidcEndpoints,
  type PkcePair,
} from './auth/oidc-jmap.js';

export {
  buildXoauth2Token,
  readXoauth2Credentials,
  type Xoauth2Config,
  type Xoauth2Credentials,
} from './auth/xoauth2-imap.js';

export {
  assertNoInlineSecret,
  readAppPassword,
  type AppPasswordConfig,
  type AppPasswordCredentials,
} from './auth/app-password-imap.js';

export {
  adapterKind,
  apply as applyMailPing,
  inject as mailPingInject,
  name as mailPingName,
  type AdapterKind,
  type MailPingResult,
} from './tools/mail-ping.js';
