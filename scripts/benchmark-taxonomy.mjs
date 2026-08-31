// Derive a category vocabulary from the mail, instead of asserting one.
//
// PRD section 4.2 specifies eight categories. Labelling their own mail, the
// owner first used three, then reported that three is too few to annotate
// correctly. Both numbers were chosen before anyone looked at what the mailbox
// actually contains, which is the thing this asks.
//
//   node scripts/benchmark-taxonomy.mjs --pass characterise|cluster|validate
//
// Three passes, because the interesting question is not "what kinds of mail
// are there" — a model will happily invent thirty — but "which distinctions
// change what the agent should do". A category that implies the same handling
// as its neighbour is a folder, not a class.
//
// PERIMETER: real message content leaves for a third-party model. The banner
// is printed, the endpoint is named, and the owner authorised it while the
// sovereign gateway's certificate is expired.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

import { JmapAdapter } from '../packages/dsh-mail-core/dist/adapters/jmap-adapter.js';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const PASS = arg('pass', 'characterise');
const COUNT = Number(arg('count', '400'));
const MODEL = arg('model', 'anthropic/claude-sonnet-5');
const BASE = 'https://openrouter.ai/api/v1';
const KEY = process.env.OPENROUTER_API_KEY;
const CORPUS = arg('corpus', '/tmp/taxonomy-corpus.json');
const KINDS = arg('kinds', '/tmp/taxonomy-kinds.json');
const SCHEME = arg('scheme', '/tmp/taxonomy-scheme.json');

if (!KEY) {
  console.error('No OPENROUTER_API_KEY.');
  process.exit(2);
}

const banner = (what) => {
  const line = (s) => console.error(`| ${s.padEnd(62)}|`);
  console.error('+' + '-'.repeat(63) + '+');
  line('THIRD-PARTY ENDPOINT: message content leaves the perimeter');
  line(`${BASE}  ${MODEL}`);
  line(what);
  console.error('+' + '-'.repeat(63) + '+');
};

async function ask(system, user, maxTokens = 4000) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (r.ok) {
      const body = await r.json();
      const choice = body.choices?.[0];
      const text = choice?.message?.content ?? '';
      // An empty body with a 200 is a truncation or a refusal, not a parse
      // problem, and saying "unparseable" about it sends the reader to the
      // wrong place.
      if (text.trim() === '') {
        throw new Error(
          `empty answer: finish=${choice?.finish_reason}/${choice?.native_finish_reason} ` +
            `completion_tokens=${body.usage?.completion_tokens} error=${JSON.stringify(body.error ?? null)}`,
        );
      }
      const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
      try {
        return JSON.parse(m ? m[1] : text);
      } catch {
        throw new Error(`unparseable answer: ${text.slice(0, 300)}`);
      }
    }
    if (r.status === 429 || r.status >= 500) {
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
      continue;
    }
    throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  throw new Error('gave up after three attempts');
}

// ---------------------------------------------------------------------------

async function fetchCorpus() {
  const ACC = process.env.MAIL_SENTINEL_JMAP_ACCOUNT_ID;
  const bearer = JSON.parse(process.env.MAIL_SENTINEL_JMAP_TOKENS).accessToken;
  let apiUrl = null;
  const jmap = async (methodCalls) => {
    if (!apiUrl) {
      const s = await fetch(process.env.MAIL_SENTINEL_JMAP_SESSION_URL, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      apiUrl = (await s.json()).apiUrl;
    }
    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        using,
        methodCalls,
      }),
    });
    return r.json();
  };
  const adapter = new JmapAdapter({
    transport: { request: (b) => jmap(b.using, b.methodCalls) },
    accountId: ACC,
    identityId: 'x',
  });
  const boxes = await jmap([['Mailbox/get', { accountId: ACC, ids: null }, 'c']]);
  const inbox = boxes.methodResponses[0][1].list.find((m) => m.role === 'inbox');
  const ids = [];
  while (ids.length < COUNT * 4) {
    const p = await jmap([['Email/query', {
      accountId: ACC, filter: { inMailbox: inbox.id },
      sort: [{ property: 'receivedAt', isAscending: false }],
      position: ids.length, limit: 256,
    }, 'q']]);
    const got = p.methodResponses[0][1].ids;
    if (got.length === 0) break;
    ids.push(...got);
  }
  const step = Math.max(1, Math.floor(ids.length / COUNT));
  const picked = ids.filter((_, i) => i % step === 0).slice(0, COUNT);
  const messages = await adapter.getMessages(picked);
  return messages.map((m, i) => ({
    n: i + 1,
    id: m.id,
    from: `${m.from[0]?.name ?? ''} <${m.from[0]?.email ?? ''}>`.trim(),
    subject: m.subject || '(sans objet)',
    preview: (m.bodyText ?? m.preview ?? '').replace(/\s+/g, ' ').trim().slice(0, 260),
    listId: m.listId,
    unsubscribe: m.listUnsubscribe.length > 0,
  }));
}

const render = (m) =>
  `[${m.n}] De: ${m.from}\nObjet: ${m.subject}\n${m.unsubscribe ? '(lien de désinscription)\n' : ''}${m.preview}`;

// --- pass 1: what is each message, in the model's own words ----------------

const CHARACTERISE = `Tu analyses les messages de la boîte professionnelle de Michel-Marie Maudet,
dirigeant de LINAGORA (logiciel libre, Twake, LinTO, IA souveraine).

Pour CHAQUE message, réponds sans vocabulaire imposé :
- "genre" : ce QU'EST le message, 2 à 5 mots, tes propres mots
- "demande" : ce que le propriétaire doit FAIRE, 2 à 6 mots, ou "rien"
- "urgence" : "delai" s'il y a une échéance explicite, sinon "aucune"
- "emetteur" : "humain", "humain-via-liste", "machine" ou "inconnu"

N'essaie pas de faire rentrer les messages dans des cases : décris ce que tu
vois. Deux messages différents doivent recevoir des descriptions différentes.

Réponds par un tableau JSON, un objet par message, dans l'ordre :
[{"n": 1, "genre": "...", "demande": "...", "urgence": "...", "emetteur": "..."}]`;

async function characterise() {
  banner(`${COUNT} messages, caractérisation libre`);
  const corpus = existsSync(CORPUS)
    ? JSON.parse(readFileSync(CORPUS, 'utf8'))
    : await fetchCorpus();
  writeFileSync(CORPUS, JSON.stringify(corpus, null, 2));

  const out = [];
  const BATCH = 20;
  for (let i = 0; i < corpus.length; i += BATCH) {
    const slice = corpus.slice(i, i + BATCH);
    const got = await ask(CHARACTERISE, slice.map(render).join('\n\n'), 4000);
    if (!Array.isArray(got) || got.length !== slice.length) {
      console.error(`batch ${i}: expected ${slice.length} answers, got ${Array.isArray(got) ? got.length : 'not an array'}`);
      process.exit(2);
    }
    out.push(...got);
    process.stderr.write(`\r  ${out.length}/${corpus.length}`);
  }
  process.stderr.write('\n');
  writeFileSync(KINDS, JSON.stringify(out, null, 2));

  const tally = (k) => {
    const c = {};
    for (const r of out) c[r[k]] = (c[r[k]] ?? 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1]);
  };
  console.log(`\n${out.length} messages caractérisés, ${tally('genre').length} genres distincts\n`);
  console.log('  les 25 genres les plus fréquents');
  for (const [k, n] of tally('genre').slice(0, 25)) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log('\n  les 20 demandes les plus fréquentes');
  for (const [k, n] of tally('demande').slice(0, 20)) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log('\n  émetteur');
  for (const [k, n] of tally('emetteur')) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log('\n  urgence');
  for (const [k, n] of tally('urgence')) console.log(`  ${String(n).padStart(4)}  ${k}`);
}

// --- pass 2: which distinctions are worth having ---------------------------

const CLUSTER = `Voici la description libre de 400 messages d'une vraie boîte professionnelle,
avec pour chacun ce qu'il est, ce qu'il demande, et qui l'envoie.

Propose la taxonomie de classement qui convient à CETTE boîte. Le nombre de
catégories est libre : moins de 8, plus de 8, peu importe. Ce qui compte est
qu'elle serve à trier réellement.

Une catégorie ne mérite d'exister que si elle passe les DEUX tests :
1. VOLUME — elle représente au moins 2% du corpus. Sous ce seuil, la
   distinction coûte plus qu'elle ne rapporte.
2. TRAITEMENT — l'agent en fait quelque chose de DIFFÉRENT de toutes les
   autres. Deux catégories qui finissent au même endroit avec la même
   urgence sont une seule catégorie mal nommée. C'est le test qui compte le
   plus : "newsletter technique" et "newsletter promotionnelle" échouent
   tous les deux s'ils sont juste lus puis oubliés.

Pour chaque catégorie proposée, donne :
- "nom" : identifiant court en kebab-case
- "definition" : une phrase, la frontière, pas une liste d'exemples
- "traitement" : ce que l'agent fait — où va le message, est-il signalé,
  entre-t-il dans le digest, appelle-t-il un brouillon de réponse
- "part" : pourcentage estimé du corpus
- "exemples" : 2 ou 3 genres du corpus qui tombent dedans
- "frontiere" : avec quelle AUTRE catégorie la confusion est la plus
  probable, et la question qui les sépare

Puis "rejetees" : les distinctions que tu as envisagées et écartées, avec la
raison — c'est aussi utile que la liste retenue.

Réponds en JSON :
{"categories": [...], "rejetees": [{"nom": "...", "raison": "..."}]}`;

async function cluster() {
  const kinds = JSON.parse(readFileSync(KINDS, 'utf8'));
  const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
  const byN = new Map(corpus.map((m) => [m.n, m]));
  const lines = kinds.map((k) => {
    const m = byN.get(k.n);
    return `${k.genre} | demande: ${k.demande} | ${k.emetteur} | ${k.urgence}` +
      (m ? ` | ex: ${m.subject.slice(0, 60)}` : '');
  });
  banner('regroupement, pas de contenu nouveau');
  const scheme = await ask(CLUSTER, lines.join('\n'), 8000);
  writeFileSync(SCHEME, JSON.stringify(scheme, null, 2));

  console.log(`\n${scheme.categories.length} catégories proposées\n`);
  for (const c of scheme.categories) {
    console.log(`  ${c.nom}  (~${c.part}%)`);
    console.log(`    ${c.definition}`);
    console.log(`    traitement : ${c.traitement}`);
    console.log(`    frontière  : ${c.frontiere}`);
    console.log('');
  }
  console.log('  écartées');
  for (const r of scheme.rejetees ?? []) console.log(`    ${r.nom} — ${r.raison}`);
}

// --- pass 3: does it actually cover the mailbox ----------------------------

async function validate() {
  const scheme = JSON.parse(readFileSync(SCHEME, 'utf8'));
  const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
  const vocabulary = scheme.categories
    .map((c) => `- ${c.nom} : ${c.definition}`)
    .join('\n');
  const system = `Classe chaque message dans exactement une catégorie.

${vocabulary}
- autre : ne rentre dans aucune des catégories ci-dessus

Utilise "autre" plutôt que de forcer un message dans une catégorie qui ne lui
va pas : le but est de mesurer si cette taxonomie couvre la boîte.

Réponds par un tableau JSON : [{"n": 1, "categorie": "..."}]`;

  banner(`validation de ${scheme.categories.length} catégories sur ${corpus.length} messages`);
  const out = [];
  const BATCH = 25;
  for (let i = 0; i < corpus.length; i += BATCH) {
    const slice = corpus.slice(i, i + BATCH);
    const got = await ask(system, slice.map(render).join('\n\n'), 3000);
    if (!Array.isArray(got) || got.length !== slice.length) {
      console.error(`batch ${i}: expected ${slice.length}, got ${Array.isArray(got) ? got.length : 'not an array'}`);
      process.exit(2);
    }
    out.push(...got);
    process.stderr.write(`\r  ${out.length}/${corpus.length}`);
  }
  process.stderr.write('\n');
  writeFileSync('/tmp/taxonomy-validation.json', JSON.stringify(out, null, 2));

  const c = {};
  for (const r of out) c[r.categorie] = (c[r.categorie] ?? 0) + 1;
  const ranked = Object.entries(c).sort((a, b) => b[1] - a[1]);
  console.log(`\n  couverture sur ${out.length} messages\n`);
  for (const [k, n] of ranked) {
    const pct = Math.round((n / out.length) * 100);
    const flag = k === 'autre' ? '  <- résidu' : pct < 2 ? '  <- sous le seuil de volume' : '';
    console.log(`  ${String(n).padStart(4)}  ${String(pct).padStart(3)}%  ${k}${flag}`);
  }
}

if (PASS === 'characterise') await characterise();
else if (PASS === 'cluster') await cluster();
else if (PASS === 'validate') await validate();
else {
  console.error(`unknown pass: ${PASS}`);
  process.exit(2);
}
