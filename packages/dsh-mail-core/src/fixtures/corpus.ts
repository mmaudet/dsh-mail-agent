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
    listId: null,
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
    expected: 'demande-interne',
    decidedBy: 'static-rule',
    because: 'sender is a colleague on the VIP list, asking the owner to confirm',
  },
  {
    message: message({
      id: 'c2',
      from: [{ name: 'Tech Digest', email: 'newsletter@techdigest.example' }],
      subject: 'Weekly digest #42',
      listUnsubscribe: ['https://techdigest.example/u/42', 'mailto:u@techdigest.example'],
      bodyText: 'Cette semaine: dix articles sur les bases de données.',
    }),
    expected: 'veille-newsletter',
    decidedBy: 'llm',
    because: 'List-Unsubscribe proves it is bulk and stops there; only the model can tell subscribed editorial from cold sales',
  },
  {
    message: message({
      id: 'c3',
      from: [{ name: 'Boutique', email: 'promos@shop.example' }],
      subject: '-40% ce week-end seulement !',
      listUnsubscribe: ['https://shop.example/unsub'],
      bodyText: 'Profitez de nos soldes exceptionnelles.',
    }),
    expected: 'veille-newsletter',
    decidedBy: 'llm',
    because: 'bulk the owner subscribed to; the tech/promo split was measured to change nothing and was dropped',
  },
  {
    message: message({
      id: 'c4',
      from: [{ name: 'GitHub', email: 'notifications@github.example' }],
      subject: '[repo] Pull request #12 merged',
      listUnsubscribe: ['https://github.example/settings/notifications'],
      bodyText: 'Your pull request was merged.',
    }),
    expected: 'support-technique-ticket',
    decidedBy: 'llm',
    because: 'a platform reporting the lifecycle of something the owner opened',
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
    expected: 'phishing-arnaque',
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
    expected: 'phishing-arnaque',
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
    // Node 5 answers 0.8, below the 0.9 the policy needs to file into Junk:
    // it reasons from a name/domain mismatch, and a generic display name on a
    // badly configured relay looks the same as an impersonation. The category
    // is the same as node 2's; only the confidence separates a filter's
    // reading from this node's inference.
    expected: 'phishing-arnaque',
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
    expected: 'demande-interne',
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
    expected: 'recu-transaction',
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
    expected: 'recu-transaction',
    decidedBy: 'static-rule',
    because: 'receipt: money that has already moved, a record to keep',
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
    expected: 'correspondance-commerciale-client',
    decidedBy: 'llm',
    because: 'a partner following up on a proposal; the slot is incidental to the offer',
  },
  {
    message: message({
      id: 'c12',
      from: [{ name: 'Claire Fontaine', email: 'claire.fontaine@corp.example.com' }],
      subject: 'Compte rendu de la réunion du 12',
      bodyText: 'Vous trouverez ci-dessous le compte rendu. Aucune action requise.',
    }),
    expected: 'rapport-compte-rendu-interne',
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

  // --- mailing lists: the one bulk header that names what it is bulk from --
  {
    message: message({
      id: 'c15',
      from: [{ name: 'Alex Fournier', email: 'alex@members.example' }],
      subject: 'Re: proposal for the next revision',
      listId: 'discuss.lists.example',
      listUnsubscribe: ['https://lists.example/u'],
      bodyText: 'I would rather we kept the current wording.',
    }),
    expected: 'liste-diffusion',
    decidedBy: 'llm',
    because:
      'List-Id is on every bulk sender too — 84 messages carry it on the target '
      + 'mailbox and 19 are list traffic — so the header is learned per list by '
      + 'node 3 rather than asserted by a static rule',
  },
  {
    message: message({
      id: 'c16',
      from: [{ name: 'Growth Team', email: 'hello@seo-agency.example' }],
      subject: 'Boostez votre visibilité dès ce mois-ci',
      listUnsubscribe: ['https://seo-agency.example/u'],
      bodyText:
        'Nous accompagnons des entreprises comme la vôtre pour tripler leur '
        + 'trafic organique. Un créneau de 15 minutes cette semaine ?',
    }),
    expected: 'prospection-commerciale-non-sollicitee',
    decidedBy: 'llm',
    because:
      'an unsubscribe link is on subscribed newsletters too; only reading it tells '
      + 'a cold pitch from content the owner asked for, and the two are handled in '
      + 'opposite directions',
  },

  // --- learned patterns: node 3, which runs before the static rules --------
  {
    message: message({
      id: 'c14',
      from: [{ name: 'Veille Interne', email: 'veille@partenaire.example' }],
      subject: 'Revue hebdo des publications',
      bodyText: 'Les publications de la semaine, sans action attendue.',
    }),
    expected: 'veille-newsletter',
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
    category: 'veille-newsletter',
    confidence: 0.9,
  },
] as const;

/** Cases the cascade must decide without any model call (the efficiency KPI). */
export const NO_LLM_CASES: readonly CorpusCase[] = CORPUS.filter(
  (entry) => entry.decidedBy !== 'llm' && entry.decidedBy !== 'below-threshold',
);
