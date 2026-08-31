/**
 * Scheduler, daily and weekly digests, and inbox triage for the DSH mail agent
 *
 * Phase 0 scaffold: this bundle intentionally ships no runtime behaviour yet.
 */

export const BUNDLE_ID = '@dsh-mail-agent/mail-digest' as const;

export type BundleId = typeof BUNDLE_ID;

export {
  summarizePeriod,
  describeDigest,
  hotThreads,
  correspondents,
  viaLists,
  within,
  type Correspondent,
  type DecisionRecord,
  type Digest,
  type DigestInput,
  type HotThread,
  type Period,
  type Waiting,
} from './summarize.js';
