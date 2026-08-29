/**
 * A synthetic corpus for exercising classification without a mailbox.
 *
 * Every message here is invented. None is derived from a real mailbox, and no
 * real person, address or thread appears: the owner's own mail is off limits
 * until Phase 3, and a corpus that cannot be committed is a corpus nobody can
 * reproduce a calibration against.
 *
 * The point is not volume. It is that each entry names the signal a classifier
 * is expected to key on, so a wrong answer says which node of the cascade
 * failed rather than only that the total dropped.
 */

import type { MailCategory, MailMessage } from '../types.js';

/** One labelled case, with the reason it is labelled that way. */
export interface CorpusCase {
  readonly message: MailMessage;
  /** What a correct classifier should answer. */
  readonly expected: MailCategory;
  /**
   * The cascade node expected to decide this, from PRD section 4.2. A case
   * decided by the wrong node is a regression even when the label is right:
   * reaching node 6 for something a static rule covers costs a model call.
   */
  readonly decidedBy:
    | 'thread-continuity'
    | 'spam-prefilter'
    | 'learned-pattern'
    | 'static-rule'
    | 'brand-spoofing'
    | 'llm'
    | 'below-threshold';
  /** Why, in one line, for whoever debugs a miss. */
  readonly because: string;
}

const OWNER = 'owner@example.org';

function message(overrides: Partial<MailMessage> & Pick<MailMessage, 'id'>): MailMessage {
  return {
    threadId: null,
    messageId: `${overrides.id}@example.org`,
    inReplyTo: [],
    references: [],
    from: [{ name: 'Someone', email: 'someone@example.org' }],
    to: [{ name: null, email: OWNER }],
    cc: [],
    subject: '',
    receivedAt: new Date('2026-08-28T09:00:00Z'),
    sentAt: new Date('2026-08-28T08:59:00Z'),
    keywords: [],
    folder: 'INBOX',
    preview: '',
    bodyText: null,
    bodyHtml: null,
    hasAttachments: false,
    spamHeaders: {},
    listUnsubscribe: [],
    ...overrides,
  };
}

export const CORPUS: readonly CorpusCase[] = [
  // --- static rules: cheapest decisions, must never reach the model ---------
  {
    message: message({
      id: 'c1',
      from: [{ name: 'Direction', email: 'ceo@corp.example.com' }],
      subject: 'Point budget avant vendredi',
      bodyText: 'Peux-tu confirmer les chiffres avant la réunion de vendredi ?',
    }),
    expected: 'important',
    decidedBy: 'static-rule',
    because: 'sender is on the VIP list; a direct question expects an answer',
  },
  {
    message: message({
      id: 'c2',
      from: [{ name: 'Tech Digest', email: 'newsletter@techdigest.example' }],
      subject: 'Weekly digest #42',
      listUnsubscribe: ['https://techdigest.example/u/42', 'mailto:u@techdigest.example'],
      bodyText: 'Cette semaine: dix articles sur les bases de données.',
    }),
    expected: 'newsletter-tech',
    decidedBy: 'static-rule',
    because: 'List-Unsubscribe plus a known bulk sender; no model call needed',
  },
  {
    message: message({
      id: 'c3',
      from: [{ name: 'Boutique', email: 'promos@shop.example' }],
      subject: '-40% ce week-end seulement !',
      listUnsubscribe: ['https://shop.example/unsub'],
      bodyText: 'Profitez de nos soldes exceptionnelles.',
    }),
    expected: 'newsletter-promo',
    decidedBy: 'static-rule',
    because: 'commercial bulk with an unsubscribe header',
  },
  {
    message: message({
      id: 'c4',
      from: [{ name: 'GitHub', email: 'notifications@github.example' }],
      subject: '[repo] Pull request #12 merged',
      listUnsubscribe: ['https://github.example/settings/notifications'],
      bodyText: 'Your pull request was merged.',
    }),
    expected: 'newsletter-notification',
    decidedBy: 'static-rule',
    because: 'machine notification from a known platform',
  },

  // --- spam prefilter: decided on headers, before any other logic -----------
  {
    message: message({
      id: 'c5',
      from: [{ name: 'Winner', email: 'noreply@lottery.example' }],
      subject: 'VOUS AVEZ GAGNE 1000000 EUR',
      spamHeaders: { 'x-spam-score': '14.8', 'x-spam-status': 'Yes' },
      bodyText: 'Cliquez pour reclamer votre prix.',
    }),
    expected: 'spam-certain',
    decidedBy: 'spam-prefilter',
    because: 'rspamd score well past the junk threshold',
  },
  {
    message: message({
      id: 'c6',
      from: [{ name: 'Support', email: 'support@unknown-domain.example' }],
      subject: 'Action requise sur votre compte',
      spamHeaders: { 'x-spam-score': '5.2', 'x-spam-status': 'No' },
      bodyText: 'Merci de vérifier vos informations.',
    }),
    expected: 'spam-probable',
    decidedBy: 'llm',
    because: 'grey zone: the prefilter defers and the model decides',
  },

  // --- brand spoofing: authentication failure, not content ------------------
  {
    message: message({
      id: 'c7',
      from: [{ name: 'PayPal', email: 'service@paypa1-secure.example' }],
      subject: 'Votre compte a été limité',
      spamHeaders: {
        'x-spam-score': '3.1',
        'x-spam-dmarc': 'fail',
        'x-spam-dkim': 'fail',
      },
      bodyText: 'Connectez-vous pour rétablir votre accès.',
    }),
    expected: 'spam-certain',
    decidedBy: 'brand-spoofing',
    because: 'display name impersonates a brand while DMARC and DKIM fail',
  },

  // --- thread continuity: inherits, and must not re-ask the model -----------
  {
    message: message({
      id: 'c8',
      threadId: 'thread-budget',
      inReplyTo: ['c1@example.org'],
      references: ['c1@example.org'],
      from: [{ name: 'Direction', email: 'ceo@corp.example.com' }],
      subject: 'Re: Point budget avant vendredi',
      bodyText: 'Merci, et peux-tu ajouter la ligne marketing ?',
    }),
    expected: 'important',
    decidedBy: 'thread-continuity',
    because: 'a reply in a thread already classified; node 1 decides at zero cost',
  },

  // --- transactional: never digested, stays in the inbox for a day ----------
  {
    message: message({
      id: 'c9',
      from: [{ name: 'Banque', email: 'noreply@bank.example' }],
      subject: 'Votre code de connexion : 481920',
      bodyText: 'Ce code expire dans 5 minutes.',
    }),
    expected: 'transactional',
    decidedBy: 'static-rule',
    because: 'one-time code; time-critical and worthless a day later',
  },
  {
    message: message({
      id: 'c10',
      from: [{ name: 'Boutique', email: 'orders@shop.example' }],
      subject: 'Confirmation de commande #88213',
      hasAttachments: true,
      bodyText: 'Votre commande a été expédiée.',
    }),
    expected: 'transactional',
    decidedBy: 'static-rule',
    because: 'receipt: a record to keep, never a digest item',
  },

  // --- the model earns its call --------------------------------------------
  {
    message: message({
      id: 'c11',
      from: [{ name: 'Camille Roy', email: 'camille.roy@partner.example' }],
      subject: 'Suite à notre échange',
      bodyText:
        'Bonjour, je reviens vers vous concernant la proposition évoquée '
        + 'la semaine dernière. Pouvons-nous caler un créneau ?',
    }),
    expected: 'important',
    decidedBy: 'llm',
    because: 'unknown human sender asking for a meeting; no rule covers it',
  },
  {
    message: message({
      id: 'c12',
      from: [{ name: 'Association', email: 'contact@asso.example' }],
      subject: 'Compte rendu de la réunion du 12',
      bodyText: 'Vous trouverez ci-dessous le compte rendu. Aucune action requise.',
    }),
    expected: 'standard',
    decidedBy: 'llm',
    because: 'informational, explicitly no action; the model must not inflate it',
  },

  // --- below threshold: the honest non-answer ------------------------------
  {
    message: message({
      id: 'c13',
      from: [{ name: '', email: 'j.dupont@unknown.example' }],
      subject: 'Question',
      bodyText: 'Bonjour, est-ce toujours d actualité ?',
    }),
    expected: 'needs-review',
    decidedBy: 'below-threshold',
    because: 'too little signal to classify; must degrade rather than guess',
  },

  // --- learned patterns: node 3, which runs before the static rules --------
  {
    message: message({
      id: 'c14',
      from: [{ name: 'Veille Interne', email: 'veille@partenaire.example' }],
      subject: 'Revue hebdo des publications',
      bodyText: 'Les publications de la semaine, sans action attendue.',
    }),
    expected: 'newsletter-tech',
    decidedBy: 'learned-pattern',
    because: 'a recurring sender the owner has always filed here, with no unsubscribe header for a static rule to key on',
  },
];

/**
 * The patterns the corpus assumes have been learned for its owner.
 *
 * Only `c14` depends on them, and it depends on them entirely: nothing in that
 * message is distinguishable by a static rule, which is the point. Node 3 runs
 * before node 4, so a case a static rule could also settle would not prove the
 * learned pattern ran.
 */
export const CORPUS_LEARNED_PATTERNS = [
  {
    sender: 'veille@partenaire.example',
    subjectContains: null,
    category: 'newsletter-tech',
    confidence: 0.9,
  },
] as const;

/** Cases the cascade must decide without any model call (the efficiency KPI). */
export const NO_LLM_CASES: readonly CorpusCase[] = CORPUS.filter(
  (entry) => entry.decidedBy !== 'llm' && entry.decidedBy !== 'below-threshold',
);
