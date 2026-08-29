/**
 * The seven-node classification cascade (PRD section 4.2).
 *
 * NOT IMPLEMENTED. The contract is in `./types.ts` and the acceptance
 * criterion is `./cascade-loop.spec.ts`, both written before this file so that
 * what is being asked for cannot drift into whatever was built.
 */

import type { MailMessage } from '../types.js';
import type { CascadeOptions, DecisionTrace } from './types.js';

export function runCascade(message: MailMessage, options: CascadeOptions): Promise<DecisionTrace> {
  void message;
  void options;
  return Promise.reject(new Error('runCascade is not implemented'));
}
