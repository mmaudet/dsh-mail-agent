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
  JmapBootstrap,
  createHttpClient,
  parseCallback,
  type AuthorizationStatus,
  type BootstrapOptions,
  type PendingAuthorization,
} from './auth/bootstrap.js';

export { EnvFileStore } from './auth/env-store.js';

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

export { MailStore, type Efficiency, type TraceSource } from './store/mail-store.js';

export {
  learn,
  describeLearn,
  type LearnResult,
} from './cascade/learn.js';

export {
  learnPatterns,
  mergePatterns,
  type LearnOptions,
  type Observation,
} from './cascade/learned-patterns.js';

export {
  readCorrections,
  describeCorrections,
  type Correction,
  type CorrectionReport,
  type DisputedRoute,
} from './cascade/corrections.js';

export {
  runAgent,
  describePass,
  backfill,
  describeBackfill,
  type AgentOptions,
  type AgentPass,
  type BackfillOptions,
  type BackfillResult,
} from './agent.js';

export {
  createLlmClassifier,
  parseVerdict,
  renderMessage,
  SYSTEM_PROMPT,
  type LlmClassifierOptions,
} from './cascade/llm-classifier.js';

export { runCascade, MODEL_UNREACHABLE } from './cascade/cascade-loop.js';

export {
  approvalFor,
  describePolicy,
  DEFAULT_POLICY,
  type Approval,
  type ApprovalPolicy,
  type ApprovalRule,
  type Decision,
  type MailAction,
} from './actions/approval.js';

export {
  planActions,
  describePlan,
  automatic,
  proposed,
  type PlannedAction,
} from './actions/plan.js';

export {
  executePlan,
  describeResult,
  type ExecuteOptions,
  type ExecutionFailure,
  type ExecutionResult,
} from './actions/execute.js';

export {
  learnStyle,
  describeStyle,
  ownWords,
  MIN_REPLIES,
  type LearnStyleOptions,
  type StyleProfile,
} from './drafts/style-profile.js';

export {
  draftReply,
  draftable,
  cleanDraft,
  renderDraftRequest,
  DRAFTABLE,
  DRAFT_SYSTEM_PROMPT,
  type Draft,
  type DraftModel,
  type DraftRequest,
} from './drafts/draft-reply.js';

export {
  pending,
  summarise,
  describeQueue,
  answered,
  ownMessage,
  addressingOf,
  type Addressing,
  type Candidate,
  type PendingItem,
  type PendingOptions,
  type QueueSummary,
} from './queue/pending.js';

export {
  asksOfOwner,
  readVerdict,
  renderForAsk,
  ASKS_SYSTEM_PROMPT,
  type AsksOptions,
} from './queue/asks.js';

export {
  detectLanguage,
  languageName,
  unquoted,
  SAMPLE_CHARS,
  type ReplyLanguage,
} from './drafts/language.js';

export {
  withQuotedThread,
  attribution,
  quoted,
  MAX_QUOTED_CHARS,
} from './drafts/quote.js';
