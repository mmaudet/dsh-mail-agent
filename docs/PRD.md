# DSH Mail Agent — PRD

**Auteur :** Michel-Marie Maudet — LINAGORA
**Date :** 28 août 2026
**Statut :** Proposition v0.5 pour test grandeur nature
**Repo cible :** `mmaudet/dsh-mail-agent` — *DeepSeek Harness mail agent with JMAP/IMAP adapters and portable React Native cockpit* (nouveau, indépendant de l'écosystème Twake)

---

## 1. Contexte et objectif

DeepSeek Harness (`dsh`), publié en août 2026, propose une orchestration où **la boucle elle-même est un plugin** montable sur Cordis, avec une composition auditable par `cordis.yml` + `cordis.patch.yml` ([DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness), [architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)). Son **mode Creator** (preset on-disk `cordis`) est explicitement pensé pour inspecter le runtime, expérimenter des plugins en mémoire, puis matérialiser un preset — c'est le workbench idéal pour construire un agent verticalisé ([agentspulse creator mode](https://agentspulse.github.io/tutorials/deepseek-harness-creator-mode/), [atoms.dev](https://atoms.dev/blog/deepseek-harness)).

Le projet **DSH Mail Agent** est un test grandeur nature du harnais DSH avec le mail comme première verticale opérationnelle. Il s'appuie sur les enseignements du prototype `twaky` (cascade sept nœuds, calibration réelle, style par propriétaire, tags Sentinel, décisions explicables) mais est **conçu comme un projet indépendant et autonome**, publié dans un nouveau dépôt `dsh-mail-agent`. Il ne dépend d'aucune brique Twake côté runtime : il parle **JMAP ou IMAP+SMTP** au choix via un adapter interchangeable, et est testable contre n'importe quel serveur mail (Apache James, Fastmail, Stalwart en JMAP ; Gmail, iCloud, Dovecot, tout provider IMAP standard).

**Objectif du chantier :**

1. Valider la portabilité d'une cascade mail spécialisée sur un harnais générique DSH.
2. Fournir un adaptateur LLM OpenAI-compatible paramétrable, agnostique au modèle, testable en A/B sur le même corpus.
3. Livrer un preset DSH complet pour le traitement de la boîte mail : classification, synthèse périodique, drafts, digests, désabonnement assisté, spam.
4. Produire matière à un article public **« Ce que l'on peut réellement faire avec DeepSeek Harness »** (voir §10).

**Non-objectifs :**

- Ne dépend d'aucune intégration Twake (ni RabbitMQ, ni Apache AGE, ni Twake Mail). Ces intégrations pourront être ajoutées en v2 comme bundles séparés opt-in.
- Ne réécrit pas la boucle standard DSH pour tous les usages : le plugin de loop mail est chargé uniquement dans le profil `mail-agent`, les autres profils DSH restent intacts.

---

## 2. Décisions structurantes actées

| Sujet | Décision | Rationale |
|---|---|---|
| Repo | **Nouveau repo indépendant `mmaudet/dsh-mail-agent`** | Autonomie complète vs Twake ; le projet est un test du harnais DSH, pas une extension d'un produit LINAGORA |
| Protocole mail | **Abstraction avec adapters JMAP natif et IMAP+SMTP interchangeables** | Élargit l'audience (Gmail/iCloud/Dovecot via IMAP, James/Fastmail/Stalwart via JMAP) sans compromettre les capacités avancées quand JMAP est disponible |
| Fenêtre de traitement | **Hybride adaptatif** : push VIP + threads actifs (JMAP `PushSubscription` ou IMAP IDLE), poll delta (`Email/queryChanges` ou `SEARCH SINCE`+UIDs), résumé à la demande | Fonctionne des deux côtés de l'adapter |
| Périmètre | **Preset DSH complet** — Sentinel mail, cascade 7 nœuds, tags par mots-clés JMAP ou fallback `\Flagged`+dossiers en IMAP, apprentissage, E2E | Test grandeur nature du harnais |
| Auth | **OIDC réutilisé** côté JMAP (mêmes `client_id` + `redirect_uri` que le prototype `twaky`) ; côté IMAP, XOAUTH2 ou app password selon le provider | Évite un nouveau ticket auprès des admins SSO |
| Topologie | **Centralisée sur Athena** : DSH tourne 24/7 sur le VPS, inférence LLM déportée sur endpoint souverain LINAGORA/OVH, MacBook = poste de dev pur | 24/7 sans laptop + souveraineté 100% européenne + simplicité opérationnelle |
| Newsletters / spam / bulk | **Triage silencieux + digest quotidien** ET **digest hebdo + désabonnement assisté** | Combinaison : quotidien pour ne rien rater sur 24h, hebdo pour l'hygiène de longue traîne |
| Modèle | **Endpoint OpenAI-compatible LINAGORA** (`chat.lucie.ovh.linagora.com/v1/`, `openai/Mistral-Small-3.2-24B-Instruct-2506-FP8`), bearer déjà provisionné, liste blanche `trusted_endpoints_only` | Souveraineté 100% européenne (LINAGORA/OVH), un seul modèle à opérer en V1, extensible à d'autres modèles de la même passerelle en Phase 7 |
| Pilotage du développement | **Hybride** : Claude Code pour scaffolding infra/tests/CI, Creator mode DSH pour les plugins Cordis et les prompts de tools | Chacun fait ce qu'il fait le mieux ; matière directe pour l'article |

---

## 3. Architecture cible

### 3.1 Un profil, trois bundles

DSH distingue **profil** (composition runnable stockée sous `$DSH_HOME/profiles/<name>`) et **bundle** (paquet npm distribuable, dont le manifest déclare un `dsh.bundle.patch`) ([dev.to seams](https://dev.to/ahab_indieseek/deepseek-harness-everything-is-a-plugin-choose-the-right-cordis-extension-seam-4773), [architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)). Le projet se compose ainsi :

```
$DSH_HOME/profiles/mail-agent/
  package.json                           # dsh.profile.bundles = [dsh-base, dsh-mail-core, dsh-mail-digest, dsh-llm-openai]
  cordis.patch.yml                       # overrides utilisateur (VIP, cadences, tenant mail)

# repo : github.com/mmaudet/dsh-mail-agent
packages/
  dsh-mail-core/                         # bundle : contrat mail + cascade + tools
    package.json                         # dsh.bundle.patch = ./cordis.patch.yml
    cordis.patch.yml
    src/
      mail-service.ts                    # service Cordis unifié, contrat abstrait
      adapters/
        jmap-adapter.ts                  # 8 méthodes JMAP
        imap-adapter.ts                  # IMAP + SMTP (IDLE, SEARCH, flags)
        types.ts                         # MailMessage, MailFolder, MailKeyword, Capabilities
      auth/
        oidc-jmap.ts                     # OIDC — réutilise client_id + redirect_uri existants
        xoauth2-imap.ts                  # XOAUTH2 (Gmail, Outlook 365)
        app-password-imap.ts             # app password (iCloud, Dovecot, legacy)
      cascade-loop.ts                    # plugin de boucle mail
      tools/
        classify_email.ts
        summarize_period.ts
        summarize_since.ts
        draft_reply.ts
        handle_newsletter.ts
        handle_spam.ts
        unsubscribe_draft.ts
      memory/
        style-profile.ts                 # profil de style par owner_email
        learned-patterns.ts              # motifs appris, health check hebdo
      guardrails/
        rspamd-prefilter.ts
        brand-spoofing.ts
        decision-trace.ts

  dsh-mail-digest/                       # bundle : scheduler + digests + notifications
    package.json
    cordis.patch.yml
    src/
      scheduler.ts                       # cron interne : quotidien + hebdo + push VIP
      digest-daily.ts
      digest-weekly.ts
      inbox-triage.ts

  dsh-llm-openai/                        # bundle : adaptateur LLM OpenAI-compat paramétrable
    package.json
    cordis.patch.yml
    src/
      openai-endpoint.ts                 # multi-endpoints, multi-modèles, budget par niveau
      model-router.ts                    # cascade 4 niveaux (économique → premium)

examples/
  profile-mail-agent/                    # profil de référence prêt à installer
    package.json
    cordis.patch.yml.example

docs/
  quickstart.md
  jmap-oidc-setup.md
  cascade-explained.md
  writing-your-own-newsletter-rule.md
```

Cette structure suit strictement la doctrine DSH « profil = composition, bundle = distribution » ([architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)) et permet à un opérateur d'écraser n'importe quelle décision par un simple `cordis.patch.yml` par-dessus, sans forker les bundles ([deepseekharness.xyz](https://deepseekharness.xyz/en)).

**Choix de nommage npm :** les bundles peuvent être publiés sous scope `@dsh-mail-agent/*` (namespace neutre) plutôt qu'un scope org — cohérent avec le fait que le projet vise à être adopté au-delà de LINAGORA.

### 3.2 Contrat mail abstrait, deux adapters

Le cœur de la portabilité JMAP/IMAP repose sur un **service Cordis unique** (`mail-service.ts`) qui expose un contrat abstrait aux tools. Les deux adapters implémentent ce contrat avec leurs mécaniques natives.

**Contrat commun (extrait) :**

```typescript
interface MailService {
  // Lecture
  listFolders(): Promise<MailFolder[]>
  queryChanges(folder: string, sinceCursor: string): Promise<MailChange[]>
  getMessages(ids: string[]): Promise<MailMessage[]>
  watchInbox(handler: (evt: MailChange) => void): AsyncDisposable  // push VIP

  // Écriture
  moveMessage(id: string, targetFolder: string): Promise<void>
  setKeywords(id: string, keywords: string[]): Promise<void>       // best-effort selon adapter
  createDraft(msg: DraftMessage): Promise<string>
  submitDraft(draftId: string): Promise<void>                       // demande approval DSH

  // Capabilities déclarées par l'adapter
  readonly capabilities: {
    push: 'jmap-push-subscription' | 'imap-idle'
    customKeywords: boolean       // true JMAP, souvent false IMAP
    threadNative: boolean         // true JMAP, false IMAP (reconstruction Message-ID/References)
    spamHeaders: boolean
  }
}
```

| Fonctionnalité | Adapter JMAP | Adapter IMAP+SMTP |
|---|---|---|
| Push temps réel (VIP) | `PushSubscription` sur `StateChange` | `IDLE` persistant sur `INBOX`, re-`IDLE` toutes les 29 min (RFC 2177) |
| Poll delta | `Email/queryChanges` avec curseur `sinceState` | `SEARCH SINCE <date>` + tracking d'UIDs, curseur = `(UIDVALIDITY, lastUID)` |
| Threads | Natifs (`Thread/get`) | Reconstruits côté client via `Message-ID` / `References` / `In-Reply-To` |
| Tags Sentinel | Mots-clés custom `Keyword/set` (`$twaky-important`) | Fallback : `\Flagged` pour `important` + dossiers dédiés `Newsletters/*`, `Junk`, `Archives/Transactions/`, `NeedsReview/` |
| Auth | OIDC (réutilisé, cf. §3.5) | XOAUTH2 (Gmail, Outlook 365) ou app password (iCloud, Dovecot) |
| Envoi | `EmailSubmission/set` | SMTP submission (587/STARTTLS ou 465/SSL) |
| Signaux spam | Headers `x-spam-*` via JMAP | Mêmes headers si exposés par le serveur (rspamd, SpamAssassin) |
| Attachments | `Blob/get` | `FETCH BODY[N]` + décodage MIME |

**Config type dans `cordis.patch.yml`** :

```yaml
- id: mail.service
  name: '@dsh-mail-agent/mail-core'
  config:
    adapter: jmap                          # ou 'imap'
    jmap:
      server_url: https://jmap.example.com
      auth: oidc                           # cf. §3.5
    # OU
    imap:
      host: imap.gmail.com
      port: 993
      tls: true
      auth: xoauth2                        # ou 'app-password'
      smtp:
        host: smtp.gmail.com
        port: 587
        starttls: true
```

Les tools LLM-visibles (`classify_email`, `draft_reply`, etc.) ne connaissent que `mail-service` : ils fonctionnent sans modification quel que soit l'adapter monté. Les comportements s'adaptent selon `capabilities` : si `customKeywords` est faux, l'action « poser tag Sentinel » retombe automatiquement sur `\Flagged` + move vers dossier.

### 3.3 La boucle mail comme plugin

Contrairement à un agent de code où la boucle standard convient, la cascade mail est **spécifique** : continuité du fil → motifs appris → règles statiques → LLM. On la matérialise comme un **plugin de loop** Cordis (`cascade-loop.ts`) qui remplace le loop standard pour la session mail. C'est précisément ce que DSH autorise : « the agent loop itself is a mountable plugin » ([README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md), [DeepSeek Harness developer preview](https://deepseek.com/harness/en/)).

Sept messages sur onze du corpus d'origine évitaient déjà l'appel LLM grâce à la cascade — cette métrique reste le KPI d'efficacité de la boucle et est mesurée en continu via la decision-trace.

### 3.4 Détail de l'adapter IMAP+SMTP

L'adapter IMAP+SMTP repose sur `imapflow` (IMAP moderne TypeScript avec IDLE, condstore) et `nodemailer` (SMTP submission). Points clés :

- **IDLE persistant** — thread dédié pour maintenir un `IDLE` sur `INBOX`, avec re-`IDLE` toutes les 29 minutes (RFC 2177) et reconnexion exponentielle en cas de coupure.
- **Curseur delta** — `(UIDVALIDITY, lastUID)` persisté. Sur reprise, `UID FETCH <lastUID+1>:* FLAGS ENVELOPE`.
- **Threads reconstruits** — parcours `Message-ID` / `References` / `In-Reply-To` côté client, indexés en local pour les cascades « continuité du fil ».
- **XOAUTH2** — pour Gmail (`imap.gmail.com`) et Outlook 365, tokens via flux OAuth device code ; app password pour iCloud et providers legacy.
- **Tags via `\Flagged` + dossiers** — `spam-certain` → move vers `Junk` (ou `[Gmail]/Spam`) ; `newsletter-*` → move vers `Newsletters/<sub>` créés à la volée ; `important` → `\Flagged`.
- **Envoi** — SMTP submission avec le compte du propriétaire, headers `Message-ID` conformes, écriture parallèle du sent dans `Sent` via IMAP `APPEND` (obligatoire côté IMAP hors Gmail).

### 3.5 Authentification JMAP — OIDC réutilisé

**Décision opérationnelle :** le bundle `dsh-mail-core/src/auth/oidc-jmap.ts` **réutilise strictement les paramètres OIDC** déjà provisionnés par les admins SSO pour le prototype `twaky` :

- `client_id` **identique** à l'existant
- `redirect_uri` **identique** à l'existant (le nouveau projet écoute sur le même chemin de callback)
- Endpoints IdP (`authorization_endpoint`, `token_endpoint`, `jwks_uri`) **identiques**
- Scopes JMAP demandés **identiques**

Concrètement : le nouveau projet démarre son callback local sur le même port et le même path (ex. `http://localhost:8765/oauth/callback`) que le prototype, de sorte qu'aucune modification côté IdP n'est nécessaire. Les seuls paramètres exposés dans `cordis.patch.yml` sont ceux qui ne touchent pas la config SSO : chemin de stockage du token chiffré, durée de rafraîchissement, tenant JMAP cible.

**Config type dans `cordis.patch.yml`** (les valeurs sensibles sont référencées par secret, jamais en clair) :

```yaml
- id: jmap.auth
  name: '@dsh-mail-agent/mail-core'
  config:
    oidc:
      # Ces trois valeurs sont IDENTIQUES au prototype précédent — ne pas changer
      client_id_ref: dsh:secret:jmap-oidc-client-id
      redirect_uri: http://localhost:8765/oauth/callback
      issuer: https://sso.example.com
      scopes: [openid, profile, jmap]
    token_storage:
      path: $DSH_HOME/state/mail-agent/tokens.enc
      encryption: dsh-secrets
```

**Note pour la documentation `docs/jmap-oidc-setup.md` :** insister sur le fait que si un utilisateur reprend le projet from-scratch dans un autre environnement SSO, il faudra alors provisionner un nouveau `client_id` et `redirect_uri` de son côté. Pour l'auteur du projet, la config existante est conservée telle quelle.

**Cas topologie distribuée (§3.7) :** quand DSH tourne sur Athena, le `redirect_uri: http://localhost:8765/oauth/callback` reste littéralement `localhost` **côté navigateur de l'admin** ; pendant l'auth interactive initiale, tu fais un tunnel SSH ponctuel `ssh -L 8765:127.0.0.1:8765 athena` pour laisser passer le callback IdP → navigateur → Athena. Une fois le refresh token obtenu et chiffré au repos sur Athena, plus besoin du tunnel.

### 3.6 Adaptateur LLM OpenAI-compatible — passerelle LINAGORA

**Décision v0.5 :** l'inférence LLM est fournie par une passerelle OpenAI-compatible hébergée par LINAGORA sur infra OVH souveraine (`https://chat.lucie.ovh.linagora.com/v1/`), authentifiée par bearer token. Un seul modèle est utilisé pour les quatre niveaux dans la V1 : `openai/Mistral-Small-3.2-24B-Instruct-2506-FP8`. Souveraineté 100% européenne, contenu mail ne quitte jamais l'infrastructure LINAGORA/OVH.

Le bundle `dsh-llm-openai` fournit :

- **Endpoint unique bearer-authentifié** pour la V1 :
  ```yaml
  - id: llm.economy
    name: '@dsh-mail-agent/llm-openai'
    config:
      base_url: https://chat.lucie.ovh.linagora.com/v1/
      model: openai/Mistral-Small-3.2-24B-Instruct-2506-FP8
      api_key_ref: dsh:secret:mail-sentinel-api-key
      max_tokens: 512
      timeout_s: 30
  - id: llm.default
    name: '@dsh-mail-agent/llm-openai'
    config: { base_url: https://chat.lucie.ovh.linagora.com/v1/, model: openai/Mistral-Small-3.2-24B-Instruct-2506-FP8, api_key_ref: dsh:secret:mail-sentinel-api-key, max_tokens: 1024 }
  - id: llm.chat
    name: '@dsh-mail-agent/llm-openai'
    config: { base_url: https://chat.lucie.ovh.linagora.com/v1/, model: openai/Mistral-Small-3.2-24B-Instruct-2506-FP8, api_key_ref: dsh:secret:mail-sentinel-api-key, max_tokens: 2048 }
  - id: llm.draft
    name: '@dsh-mail-agent/llm-openai'
    config: { base_url: https://chat.lucie.ovh.linagora.com/v1/, model: openai/Mistral-Small-3.2-24B-Instruct-2506-FP8, api_key_ref: dsh:secret:mail-sentinel-api-key, max_tokens: 2048 }
  ```
  Variables d'environnement de référence (aliases historiques du prototype twaky, conservés pour compatibilité) : `MAIL_SENTINEL_API_BASE`, `MAIL_SENTINEL_API_KEY`, `MAIL_SENTINEL_ECONOMY_LLMS`, `MAIL_SENTINEL_DEFAULT_LLMS`, `MAIL_SENTINEL_CHAT_LLMS`, `MAIL_SENTINEL_DRAFT_LLMS`.

- **Model router** : chaque tool déclare son niveau requis (`draft_reply` → `draft`, `classify_email` → `economy`, `summarize_period` → `default` ou `chat`). En V1 tous pointent sur le même modèle Mistral-Small ; la structure niveau-par-niveau est préservée pour pouvoir différencier plus tard sans refactor.

- **Flag `trusted_endpoints_only`** : liste blanche de `base_url` autorisés. En V1 = `['https://chat.lucie.ovh.linagora.com/v1/']`. Toute tentative de routage vers un endpoint hors liste est bloquée avec log de sécurité. Remplace la notion binaire `local_only` de v0.4, mieux adaptée à une souveraineté gérée par endpoint plutôt que par localisation réseau.

- **Health-check** : ping périodique de `/v1/models` toutes les 60 s ; si l'endpoint est down, l'agent dégrade vers la cascade statique seule (pas d'appel LLM), plutôt que de basculer sur un endpoint tiers non souverain.

- **Mode A/B testable (V2)** : un flag `experiment.model_variants` permettra plus tard d'ajouter d'autres modèles de la même passerelle (Mistral-Large, Codestral, etc.) et de comparer leurs performances sur le même corpus réel — matière pour l'article §10.

### 3.7 Topologie : DSH sur Athena + passerelle LLM LINAGORA

Le scheduler quotidien et hebdomadaire, le poll delta, l'IDLE IMAP et la `PushSubscription` JMAP doivent tourner **24/7 et indépendamment de l'état du laptop**. La topologie retenue est donc **centralisée sur Athena**, avec l'inférence LLM déportée sur la passerelle souveraine LINAGORA (cf. §3.6) :

```
 +----------------------------------------------+          +---------------------------------------+
 |  Athena VPS (Debian, systemd, Tailscale)     |          |  MacBook Pro M4 Pro (macOS, Tailscale)|
 |                                              |          |                                       |
 |  * dsh --profile mail-agent (systemd svc)    |          |  * Claude Code (dev, scaffolding)     |
 |  * scheduler cron interne                    |          |  * SSH client vers Athena             |
 |  * IMAP IDLE / JMAP PushSubscription         |          |  * navigateur -> DSH web UI           |
 |  * decision-traces persistantes (SQLite)     |          |    via ssh -L ou tailscale serve      |
 |  * /runs/[id] web UI (127.0.0.1:3080)        |          |                                       |
 |  * cockpit RN (V2) sur 127.0.0.1:3090        |          |                                       |
 +----------------------------------------------+          +---------------------------------------+
              |                    |
              v                    v
       serveur mail        HTTPS bearer
       (JMAP ou IMAP)             |
                                  v
              +---------------------------------------+
              |  Passerelle LLM LINAGORA              |
              |  chat.lucie.ovh.linagora.com/v1/      |
              |  Mistral-Small-3.2-24B-Instruct-FP8   |
              |  Infrastructure LINAGORA / OVH        |
              +---------------------------------------+
```

**Composants sur Athena :**
- Node.js 22, pnpm, DSH cloné + built (`0.1.2-alpha.1` validé), profils `mail-agent-dev` et `mail-agent-prod`
- Service systemd `dsh-mail-agent.service` avec `Restart=always`
- Tailscale connecté au tailnet (déjà en place, cf. [projects/kimi-remote])
- SQLite pour decision-traces, curseurs, patterns appris, profil de style
- Secret `MAIL_SENTINEL_API_KEY` stocké chiffré dans `dsh-secrets`, jamais dans le repo git
- Aucun modèle local, aucun `llama.cpp`, aucun `mlx_lm.server` — l'inférence sort en HTTPS bearer vers la passerelle LINAGORA
- Rien qui écoute sur l'internet public — tout accès admin passe par SSH ou Tailscale

**Composants sur MacBook :**
- Claude Code, `gh` CLI, SSH client vers Athena, navigateur pour la web UI DSH et plus tard le cockpit
- Aucun modèle local requis pour la V1 — le MacBook devient un simple poste de dev
- Peut être fermé sans impact sur le service, qui tourne entièrement sur Athena

**Accès à la web UI DSH depuis n'importe où :**

Option 1 — SSH tunnel classique ([dshdocs remote server](https://dshdocs.com/faqs/how-to-run-dsh-web-on-a-remote-server/)) :
```bash
ssh -L 3080:127.0.0.1:3080 athena.tailnet.ts.net
# puis http://localhost:3080 dans le navigateur
```

Option 2 — Tailscale Serve (plus élégant, TLS auto) :
```bash
# sur Athena
tailscale serve --https=443 --set-path=/dsh http://127.0.0.1:3080
# puis https://athena.tailnet.ts.net/dsh depuis n'importe quel appareil du tailnet
```

**Pilotage programmatique optionnel via ACP.** DSH expose aussi un serveur ACP (Agent Client Protocol) sur JSON-RPC stdio, utile si un jour tu veux piloter `mail-agent` depuis un autre agent (Claude Code, Codex, Zed) plutôt que depuis la web UI ([ACP Protocol — DeepWiki](https://deepwiki.com/deepseek-ai/deepseek-harness/7.1-acp-protocol-and-agent-communication)). Pas requis pour le POC.

**Avantages de cette topologie simplifiée (v0.5) :**
1. **24/7 sans laptop** — scheduler, IDLE, push tournent en continu sur Athena.
2. **Souveraineté par endpoint** — 100% du contenu mail transite entre Athena (VPS souverain) et la passerelle LLM LINAGORA/OVH. Aucun modèle américain touché, aucune donnée sortie de l'écosystème européen.
3. **Simplicité opérationnelle** — pas de modèles locaux à gérer, pas de GGUF à télécharger, pas de MLX server à maintenir sur le laptop, pas de gestion primary/fallback complexe.
4. **Sécurité par défaut** — DSH bind sur `127.0.0.1`, jamais sur `0.0.0.0`. Aucun port exposé à l'internet public. Sortie unique en HTTPS vers un endpoint sur liste blanche (`trusted_endpoints_only`).
5. **Dev/prod partagés sur Athena** — profil `mail-agent-dev` pour Creator mode + profil `mail-agent-prod` pour le service systemd 24/7. Jamais de session Creator sur le profil prod.
6. **Une seule API key à gérer** — bearer LINAGORA déjà provisionné (`MAIL_SENTINEL_API_KEY`), réutilisé du prototype précédent, aucun ticket admin nouveau.

**Limites à connaître :**
- **Dépendance réseau Athena ↔ passerelle LLM** — si la passerelle est indisponible ou si Athena perd sa connectivité sortante, l'agent dégrade vers la cascade statique seule (pas d'appel LLM). Aucun modèle tiers non souverain n'est appelé en secours par défaut.
- **Latence réseau HTTPS** — typiquement 100-300 ms par appel vers la passerelle, acceptable pour du mail non temps réel critique.
- **OAuth init interactif** — nécessite un tunnel SSH ponctuel `ssh -L 8765:127.0.0.1:8765 athena` pour laisser passer le callback IdP → navigateur → Athena. Une seule fois par tenant, plus jamais après si les refresh tokens tiennent.
- **Perte de la démo « 100% local sur mon laptop »** — la V1 ne démontre plus l'inférence sur matériel Apple Silicon. Cette démo est reportée en V2 optionnelle si un besoin éditorial le justifie (cf. §9.2).

---

## 4. Verticale mail — spécification fonctionnelle

### 4.1 Fenêtre de traitement — hybride adaptatif

Trois voies coexistent, arbitrées par le scheduler du bundle `dsh-mail-digest` :

**Voie 1 — Push VIP temps réel.** Une `PushSubscription` JMAP s'abonne aux `StateChange` de la mailbox `Inbox`. Un mail entrant déclenche la cascade **si** l'expéditeur est VIP (liste maintenue dans `learned-patterns`) OU **si** le thread est actif (dernière activité < 24h ET propriétaire a répondu au moins une fois). Objectif : latence < 15s pour les mails qui comptent.

**Voie 2 — Poll delta paramétrable.** `Email/queryChanges` toutes les *N* minutes (défaut 15, ajustable par `cordis.patch.yml`) contre un curseur `sinceState` persistant. Traite le reste de la boîte hors VIP. Faible coût réseau et offline-friendly.

**Voie 3 — Digest à la demande.** Un tool `summarize_since(last_check)` est exposé au propriétaire, qui peut demander à tout moment « qu'est-ce qui s'est passé depuis 7h ce matin ? ». Utilise le curseur JMAP + la mémoire des décisions récentes.

Le curseur `sinceState` par mailbox est stocké dans la persistence Cordis (service `state.mail.cursor`).

### 4.2 Classification — cascade sept nœuds

La cascade est implantée dans `cascade-loop.ts` :

1. **Continuité du fil** — si le mail est une réponse dans un thread où le propriétaire a déjà agi, hériter de la classification du thread (aucun appel LLM).
2. **Prefilter rspamd** — signaux `x-spam-*` exposés par JMAP consommés avant toute autre logique. Trois zones : clean / grey / junk. Junk classé direct, grey passe à l'étape 3.
3. **Motifs appris** — patterns statistiques accumulés par owner (expéditeurs récurrents, patrons de sujet, dossiers cibles habituels). Réévalués par un LLM check hebdo.
4. **Règles statiques** — VIP explicites, domaines corporate, listes de diffusion connues.
5. **Détection brand spoofing** — SPF/DKIM/DMARC via headers, similarité domain vs display-name.
6. **LLM classification** — appel `classify_email` sur le niveau `economy` par défaut. Le prompt renvoie une catégorie + confiance + rationale courte.
7. **Seuil de confiance** — sous le seuil calibré (0.75 par défaut), le mail est marqué `needs-review` et laissé en Inbox sans action automatique.

**Catégories cibles** (union des deux politiques bulk choisies) :

- `important` — VIP, réponse attendue, action requise
- `standard` — informatif, à lire
- `newsletter-tech`, `newsletter-promo`, `newsletter-notification` — sous-catégories fines pour les digests
- `transactional` — reçus, confirmations, code 2FA (traitement à part : jamais dans un digest, restent en Inbox 24h puis archivés)
- `spam-probable` — LLM incertain, révision hebdo
- `spam-certain` — junk direct

### 4.3 Synthèse — « qu'est-ce qui s'est passé »

Le tool `summarize_period(from, to)` prend une fenêtre temporelle et produit une synthèse structurée :

- **Top 5 mails importants** — titre + expéditeur + résumé 1 ligne + lien direct + action suggérée
- **Threads chauds** — fils avec ≥3 messages sur la fenêtre, résumés en 2 lignes chacun
- **Newsletters marquantes** — 3 sujets saillants extraits des newsletters de la période
- **En attente de ta réponse** — mails classés `important` sans réponse envoyée après N jours
- **Compteurs** — nb total, nb triés silencieusement, nb ayant appelé le LLM (efficacité cascade)

Deux modes d'invocation :

- **Automatique** : digest quotidien à 8h + digest hebdo lundi 8h (paramétrable par `cordis.patch.yml`, timezone Europe/Paris par défaut).
- **À la demande** : `summarize_since(last_check)` — pratique pour un retour de réunion ou de weekend.

Livré par mail interne (auto-adressé), par une vue web dédiée dans le bundle web-app DSH, ou exportable JSON pour intégration externe.

### 4.4 Draft de réponse

`draft_reply(email_id, tone_hint?)` implémente :

1. **Sélection du profil de style par `owner_email`** — construit à partir des messages envoyés (mailbox `Sent`).
2. **Rafraîchissement automatique** — le service `style-profile` réanalyse la Sent Mailbox à cadence configurable (défaut : chaque lundi).
3. **Prompt structuré** — langue détectée sur le mail entrant, salutation + formule de clôture + signature du profil de style, contenu généré par le LLM au niveau `standard` ou `premium` selon la classification (`important` → premium).
4. **Brouillon JMAP** — écrit dans `Drafts` via `Email/set`, jamais envoyé automatiquement. Le propriétaire garde 100% du contrôle d'envoi.
5. **Apprentissage sous flag** — la boucle d'apprentissage écriture reste derrière un flag désactivé par défaut ; elle observe les édits que le propriétaire applique aux drafts avant envoi.

### 4.5 Bulk — newsletters, spam, transactionnel

**Newsletters** — sous-catégories fines :

| Sous-catégorie | Action immédiate | Digest quotidien | Digest hebdo | Désabonnement assisté |
|---|---|---|---|---|
| `newsletter-tech` | Move → `Newsletters/Tech` | ✓ (top 3 sujets) | ✓ | Après 4 semaines sans ouverture, `unsubscribe_draft` proposé |
| `newsletter-promo` | Move → `Newsletters/Promo` | — | ✓ (compteur) | Après 2 semaines sans clic, désabo suggéré |
| `newsletter-notification` | Move → `Newsletters/Notifications` | — | ✓ (compteur) | Manuel uniquement |

Le tool `unsubscribe_draft(sender)` extrait l'URL `List-Unsubscribe` du header (RFC 2369), prépare soit un mailto pré-rempli soit ouvre l'URL HTTP dans le brouillon d'action, mais **n'envoie / ne clique jamais automatiquement**.

**Spam** :

- `spam-certain` → Junk direct, jamais dans les digests, sauf si l'expéditeur est dans le carnet d'adresses (faux-positif suspect → `needs-review`).
- `spam-probable` → Junk mais listé dans le digest hebdo « à vérifier » (5 mails max), permet à l'utilisateur de rappliquer un pattern.

**Transactionnel** (reçus, 2FA, confirmations) — jamais résumé (bruit), tag visible mais laissé en Inbox 24h puis archivé automatiquement dans `Archives/Transactions/`.

### 4.6 Audit et explicabilité

Chaque exécution produit une **decision-trace** : quel nœud de la cascade a tranché, avec quels signaux, quel modèle appelé (si LLM), quel coût, quelle confiance, quelle action. Traces exposées :

- Vue `/runs/[id]` reprise du bundle web-app DSH
- API JSON pour intégration Langfuse ou autre observabilité externe
- Export CSV pour audit de conformité

Le health check hebdo LLM évalue la santé des motifs appris et signale les dérives (ex. un pattern d'expéditeur qui commence à générer trop de `needs-review`).

### 4.7 Sécurité et garde-fous

- **OIDC pour JMAP** — jamais de tokens manuels, tokens chiffrés au repos par le service de secrets DSH. Réutilise `client_id` + `redirect_uri` existants (voir §3.4).
- **Approval policy DSH** — configurable ; par défaut, tout `Email/set` sur `Drafts` autorisé sans approval, tout `EmailSubmission/set` (envoi) et tout `Mailbox/set` (création/suppression de dossiers) demande approval explicite.
- **Sandbox par tenant** — un profil DSH par owner_email + tenant JMAP. Impossible de croiser les boîtes.
- **Trace par événement** — réinitialisée à chaque `StateChange`, interdiction des tests d'intégration sur une base de production (rappel dans le CI).

---

## 5. Pilotage du développement — Claude Code + Creator mode

**Question méta :** faut-il piloter le développement du projet avec Claude Code (ou Codex CLI) sur le MacBook, ou avec DSH lui-même en Creator mode ?

**Réponse : les deux, sur des phases distinctes.** Chacun est bon à ce que l'autre fait moins bien, et l'expérience de cette double approche est un élément central de l'article public (§10).

### 5.1 Claude Code fait mieux pour

- **Bootstrap et scaffolding** — monorepo pnpm, structure de packages, `tsconfig`, `.eslintrc`, `.gitignore`, CI GitHub Actions.
- **Provisioning Athena** — écriture des unités systemd, config Tailscale, hardening SSH, dépôt du secret bearer LLM dans `dsh-secrets`.
- **Tests** — tests unitaires (Vitest), tests d'intégration contre serveurs mail de test, suite E2E.
- **Refactors larges multi-fichiers** — renommages, extractions d'interfaces, migrations de dépendances.
- **Documentation** — README, quickstart, `docs/*.md`, ADRs, contenus destinés au repo public.
- **Travail cross-repo** — synchroniser un changement d'API dans les bundles avec la doc et les exemples.

Côté MacBook, Claude Code s'exécute localement, voit tous les fichiers du repo, peut invoquer `pnpm`, `git`, `ssh athena` pour appliquer des changements côté VPS.

### 5.2 Creator mode DSH fait mieux pour

Le mode Creator de DSH (preset on-disk `cordis`) permet d'écrire les plugins **depuis DSH lui-même**, avec inspection du runtime en direct et expérimentations en mémoire ([agentspulse creator mode](https://agentspulse.github.io/tutorials/deepseek-harness-creator-mode/), [deepseek-harness.app modes](https://deepseek-harness.app/modes)).

- **Écriture des plugins Cordis** — `cascade-loop.ts`, `mail-service.ts`, adapters. Creator mode peut inspecter le runtime en direct (`inspect-runtime`), monter un plugin en RAM (`mount`), le tester contre un mail réel dans la même boucle sans redémarrer DSH.
- **Itération sur les prompts des tools LLM** — `classify_email`, `draft_reply`, `summarize_period`. Le mode Creator voit les decision-traces en direct et peut A/B tester deux versions du prompt sur le même corpus.
- **Debug des dépendances Cordis** — ordre de mount, patches en couches, conflits entre bundles.
- **Validation live** — quand un plugin doit être testé contre une vraie boîte, Creator mode le fait dans un contexte où toute la stack DSH (auth, secrets, decision-trace) est déjà chargée.

Le trust boundary Creator est explicite : traiter cette session **comme un shell access** ([atoms.dev](https://atoms.dev/blog/deepseek-harness)) — jamais Creator mode sur mailbox de production avant qu'un plugin ait été validé en dev.

### 5.3 Répartition concrète par phase

| Phase | Pilote principal | Rôle secondaire |
|---|---|---|
| 0 — Bootstrap repo + Athena + passerelle LLM | **Claude Code** (MacBook) | — |
| 1 — Contrat mail + adapters + auth | **Claude Code** pour scaffolding et tests, puis **Creator mode DSH sur Athena** pour valider l'auth OIDC en live | — |
| 2 — Cascade + classification | **Creator mode DSH** pour cascade-loop, tools, prompts | Claude Code pour tests unitaires et refactors |
| 3 — Actions mail + tags | **Creator mode DSH** contre serveur mail de test | Claude Code pour E2E |
| 4 — Digests + scheduler | **Creator mode DSH** pour scheduler et push, **Claude Code** pour systemd et cron sur Athena | — |
| 5 — Draft de réponse + style | **Creator mode DSH** — itérations intensives sur les prompts | Claude Code pour tests de régression |
| 6 — Unsubscribe | Répartition équilibrée | — |
| 7 — Multi-modèles A/B | **Creator mode DSH** pour les runs A/B en direct | Claude Code pour le dashboard de comparaison |
| 8 — E2E + durcissement + docs | **Claude Code** | Creator mode pour valider les scénarios finaux |

### 5.4 Règles d'hygiène communes

- **Jamais Creator mode sur ta boîte perso** avant la Phase 3. Toujours contre un serveur mail de test (Apache James local, ou boîte Gmail dédiée avec app password).
- **Ne jamais modifier un preset officiel DSH** — toujours copier puis modifier. Le profil `mail-agent` est notre copie, isolée sous `$DSH_HOME/profiles/mail-agent/`.
- **Un profil dev + un profil prod séparés sur Athena** — `mail-agent-dev` pour Creator mode, `mail-agent-prod` pour le service systemd 24/7. Jamais de session Creator sur le profil prod.
- **Les modifications Creator mode qui doivent persister vont dans le repo git**, pas seulement dans le state DSH. Sinon perte à la prochaine reprovision d'Athena.

### 5.5 Bootstrap concret (Phase 0 en pratique)

```bash
# Sur le MacBook, avec Claude Code
gh repo create mmaudet/dsh-mail-agent --public --license MIT
cd dsh-mail-agent
pnpm init && pnpm add -D typescript vitest
mkdir -p packages/dsh-mail-core packages/dsh-mail-digest packages/dsh-llm-openai
# ... Claude Code scaffolde tsconfig, tests, CI
git push

# Sur Athena, via SSH depuis le MacBook
ssh athena.tailnet.ts.net
git clone https://github.com/mmaudet/dsh-mail-agent && cd dsh-mail-agent
pnpm install && pnpm run build
git clone https://github.com/deepseek-ai/deepseek-harness ~/dsh && cd ~/dsh
pnpm install && pnpm run build
mkdir -p ~/.dsh/profiles/mail-agent-dev
# ... config profil, systemd unit stub, dépôt du secret MAIL_SENTINEL_API_KEY

# De retour sur MacBook — Creator mode contre Athena
ssh -L 3080:127.0.0.1:3080 athena.tailnet.ts.net
# nouvelle session : pnpm dsh --profile creator (sur Athena)
# navigateur MacBook : http://localhost:3080 → mode Creator
```

---

## 6. Plan par phases

**Convention de complexité** : S ≈ 1-2 jours, M ≈ 3-5 jours, L ≈ 1-2 semaines.

### Phase 0 — Bootstrap Athena + passerelle LLM (S)

- Nouveau repo `mmaudet/dsh-mail-agent` initialisé sur GitHub (public, MIT, monorepo pnpm) — depuis le MacBook via Claude Code
- Provisioning Athena : DSH `0.1.2-alpha.1` déjà cloné et buildé (étape 1A validée), création des profils `mail-agent-dev` et `mail-agent-prod` vides contenant seulement `dsh-base`
- Provisioning du secret : `MAIL_SENTINEL_API_KEY` déposé dans `dsh-secrets` sur Athena, jamais dans le repo git
- Bundle `dsh-llm-openai` avec quatre niveaux (`llm.economy`, `llm.default`, `llm.chat`, `llm.draft`) pointant tous sur la passerelle LLM LINAGORA `https://chat.lucie.ovh.linagora.com/v1/`, modèle `openai/Mistral-Small-3.2-24B-Instruct-2506-FP8`
- Tool `chat.completions` câblé, flag `trusted_endpoints_only: ['https://chat.lucie.ovh.linagora.com/v1/']` activé
- Unit systemd `dsh-mail-agent.service` stub, non activé
- Sanity : agent DSH répond en français via la passerelle, mesure de latence, vérification que l'agent dégrade proprement (pas de crash) si l'endpoint est momentanément `curl`-inaccessible

**Sortie :** `dsh --profile mail-agent-dev` sur Athena parle à la passerelle LLM en HTTPS bearer, web UI accessible via SSH tunnel ou Tailscale serve.

### Phase 1 — Contrat mail + adapters JMAP et IMAP + auth (L)

- Bundle `dsh-mail-core` avec `mail-service.ts` (contrat abstrait), `adapters/jmap-adapter.ts`, `adapters/imap-adapter.ts`
- Auth : `auth/oidc-jmap.ts` (réutilise strictement `client_id` + `redirect_uri` existants, tunnel SSH ponctuel pour init OAuth vers Athena), `auth/xoauth2-imap.ts`, `auth/app-password-imap.ts`
- Callback local sur même port/path que le prototype précédent, aucun changement côté admins SSO
- Tool debug `mail_ping` (vérifie que l'adapter monté répond, retourne `capabilities`)
- Tests d'intégration sur trois cibles : Apache James local (JMAP), Dovecot en Docker (IMAP+SMTP), boîte Gmail dédiée avec XOAUTH2

**Sortie :** l'agent lit une boîte via l'un ou l'autre adapter par simple `cordis.patch.yml`, sans nouveau ticket SSO.

### Phase 2 — Cascade + classification (L)

- Boucle mail plugin (`cascade-loop.ts`)
- Tools `classify_email`, prefilter rspamd, patterns statiques, brand spoofing
- Persistence des curseurs `sinceState`
- Decision-trace + vue `/runs/[id]`

**Sortie :** batch classifier une mailbox réelle (dry-run, aucune écriture).

### Phase 3 — Actions mail + tags (M)

- Écriture des mots-clés personnalisés via JMAP `Keyword/set` quand `capabilities.customKeywords` est vrai
- Fallback `\Flagged` + dossiers dédiés (`Newsletters/*`, `Junk`, `Archives/Transactions/`, `NeedsReview/`) quand `capabilities.customKeywords` est faux (IMAP typique)
- Move vers dossiers, création à la volée si absents
- Approval policy DSH configurée

**Sortie :** premier run réel sur mailbox de test avec écritures.

### Phase 4 — Digests + scheduler hybride + prod systemd (M)

- Bundle `dsh-mail-digest` : cron interne, push (JMAP `PushSubscription` ou IMAP IDLE), poll delta
- Tools `summarize_period`, `summarize_since`
- Digest quotidien 8h + hebdo lundi 8h, timezone Europe/Paris
- Activation `dsh-mail-agent.service` en mode `--profile mail-agent-prod` sur Athena, redémarrages automatiques, journaux vers journald

**Sortie :** premier digest quotidien reçu par mail auto-adressé, service tourne 24/7 entièrement sur Athena, indépendant de l'état du MacBook.

### Phase 5 — Draft de réponse + style (M)

- Service `style-profile` (analyse `Sent` mailbox)
- Tool `draft_reply` avec sélection par owner
- Refresh hebdo du profil de style
- Approval sur `EmailSubmission/set`

**Sortie :** brouillons pertinents dans `Drafts` pour les mails `important`.

### Phase 6 — Unsubscribe + désabonnement assisté (S)

- Tool `unsubscribe_draft`
- Compteurs d'ouverture / clic par newsletter
- Suggestions dans le digest hebdo

**Sortie :** proposition proactive « 3 newsletters à désabonner ».

### Phase 7 — Multi-modèles A/B via la passerelle LLM (S)

- Model router avec `experiment.model_variants`
- Ajout d'autres modèles disponibles sur la même passerelle (variantes Mistral-Small avec quantifications différentes, Mistral-Large si exposé, etc.), même endpoint bearer
- Dashboard de comparaison sur decision-traces (efficacité cascade, coût, latence, subjective quality via petit label humain)

**Sortie :** rapport comparatif de plusieurs modèles sur 500 mails de ta boîte — **matière directe pour l'article DSH** (voir §10).

### Phase 8 — E2E + durcissement (M)

- Suite E2E
- Health check hebdo LLM des patterns
- Doc opérateur, `docs/jmap-oidc-setup.md`, flags par défaut

**Sortie :** version 1.0 déployable et documentée pour reproduction publique.

**Durée totale estimée :** 6-8 semaines à mi-temps équivalent — gain d'une semaine par rapport à v0.4 grâce à la simplification de la topologie (Phase 0 : M → S, plus de setup MLX ni llama.cpp). Moins si tu délègues intensivement à Creator mode en pair-agent.

---

## 7. Métriques de succès du test grandeur nature

1. **Efficacité cascade** — ≥ 60% des mails classés sans appel LLM (baseline prototype : 7/11 ≈ 64%).
2. **Précision classification** — sur un échantillon labellisé de 200 mails, F1 ≥ 0.90 sur `important` vs reste.
3. **Latence VIP** — mail VIP → notification < 15s (P95) via push JMAP.
4. **Qualité digest** — sur 4 semaines, tu valides que le digest quotidien couvre ≥ 80% de ce que tu aurais lu manuellement (auto-label subjectif).
5. **Qualité draft** — sur 30 drafts générés, ≥ 50% envoyés avec édition mineure (< 20% de caractères modifiés).
6. **Souveraineté par endpoint** — 100% des appels LLM vont vers `chat.lucie.ovh.linagora.com` (vérifiable via decision-traces et logs `trusted_endpoints_only`), 0% de fuite vers un endpoint tiers non souverain.
7. **Auditabilité** — 100% des exécutions ont une decision-trace complète accessible via `/runs/[id]`, incluant `base_url` et `model` utilisés.

---

## 8. Risques et parades

| Risque | Impact | Parade |
|---|---|---|
| DSH est en developer preview (v0.1) — API instable | Refactos forcés pendant le POC | Pin sur une version RC précise, vendorer si besoin comme DSH le fait avec Cordis 4.0.0-rc.7 |
| Le plugin de boucle mail concurrence le loop standard | Comportement inattendu si les deux se chargent | Isoler par profil : `mail-agent` ne monte **pas** le loop standard, seulement `cascade-loop` |
| Creator mode = shell-level trust | Fuite ou corruption si mal maîtrisé | Jamais Creator mode sur mailbox de prod, session Creator toujours contre serveur JMAP de test, isolation par profil séparé |
| Endpoint LLM tiers non souverain appelé par erreur | Fuite de contenu mail hors écosystème LINAGORA/OVH | Liste blanche `trusted_endpoints_only` = `['https://chat.lucie.ovh.linagora.com/v1/']`, tout autre `base_url` est refusé avec log de sécurité |
| Push JMAP `PushSubscription` non supporté par certains serveurs | Perte de la voie temps-réel | Fallback automatique vers poll delta à cadence plus rapide (5 min) pour les VIP |
| Style-profile fuit du contenu privé dans le prompt | Vie privée | Ne jamais mettre de contenu de mail dans le profil de style, seulement des méta (langue, salutation, signature, longueur moyenne) |
| Rotation de `client_id` OIDC côté IdP pendant le projet | L'auth se casse | Le projet consomme le `client_id` par référence de secret ; rotation = mise à jour d'un secret DSH, aucun changement de code |
| Passerelle LLM indisponible (maintenance, incident) | Plus de classification LLM | Dégradation gracieuse : la cascade statique continue de fonctionner (règles, patterns, prefilter rspamd) ; les tools qui nécessitent LLM (draft, résumé) mis en attente jusqu'à rétablissement, avec compteur remonté dans le digest |
| Bearer `MAIL_SENTINEL_API_KEY` compromis | Accès abusif à la passerelle | Stockage chiffré dans `dsh-secrets` sur Athena, jamais dans le repo git ; rotation par simple mise à jour du secret ; audit périodique des logs côté LINAGORA |
| Latence réseau HTTPS Athena ↔ passerelle LLM | Ralentit classification (100-300 ms/appel) | Impact acceptable pour du mail non temps-réel ; batching des appels quand possible ; monitoring de latence dans le digest santé |
| Reboot Athena pendant IDLE IMAP | Coupure sur INBOX | Service systemd `Restart=always` + reconnexion IDLE avec back-off exponentiel ; curseur `(UIDVALIDITY, lastUID)` persisté |
| OAuth init OIDC via tunnel SSH | Friction d'initialisation | Documenter `ssh -L 8765:127.0.0.1:8765 athena` dans `docs/jmap-oidc-setup.md` ; opération ponctuelle, refresh token duré |
| Adapter IMAP sans push natif | Latence VIP dégradée | IDLE persistant sur `INBOX` (RFC 2177), re-`IDLE` 29 min, poll rapide 5 min en fallback pour VIP |

---

## 9. Choix laissés ouverts pour v2

### 9.1 Cockpit métier React Native (feature phare de la V2)

**Motivation.** La web UI DSH est excellente pour le debug technique (`/runs/[id]`, decision-trace, Creator mode) mais rugueuse pour l'usage métier quotidien : elle n'offre pas de vue « mes mails classés par bucket », ni de validation rapide des drafts, ni de digest interactif, ni de vue santé système. Un cockpit métier dédié comble ce trou sans refaire un client mail complet — le mail reste dans Apple Mail, Gmail ou Twake Mail, le cockpit pilote seulement les décisions de l'agent.

**Choix stack : React Native (Expo).** Aligné sur la stack front LINAGORA et cohérent avec l'expertise mobile de l'équipe (cf. [[projects/react-native-matrix-crypto]]). Un seul codebase couvre iOS, Android, et via `react-native-web` ou Expo Router à target `web` également la vue desktop dans le navigateur. Pas de duplication SPA vs mobile.

**Portes d'entrée :**
- **iOS/Android natif** — app Expo buildée via EAS, sideloadable en dev, publiable en TestFlight/Play interne pour l'équipe LINAGORA quand le projet mûrit.
- **Web** — même code compilé avec `expo export --platform web`, servi par Athena via `tailscale serve --https=443 --set-path=/cockpit`, accessible depuis n'importe quel navigateur du tailnet.

**Fonctionnalités cockpit V2 :**

1. **Inbox agent** — liste des mails classés depuis le dernier digest, groupés par bucket (`important`, `à répondre`, `newsletters`, `à archiver`, `NeedsReview`), badge de confiance cascade (vert = pattern statique, jaune = LLM), swipe pour approuver / corriger le tag. La correction alimente `patterns.jsonl` via `correctTag(...)`.
2. **Drafts en attente** — liste des `draft_reply` non envoyés, édition inline mobile-friendly, validation en un tap → déclenche `submitDraft` (JMAP `EmailSubmission/set` ou SMTP). C'est **le vrai gain quotidien** vs web UI DSH.
3. **Digests interactifs** — digest quotidien 8h + hebdo lundi 8h rendus en composants riches, liens directs vers threads sources, boutons « désabonner cette newsletter » (→ `unsubscribe_draft`), « ajouter en VIP ».
4. **Santé système** — statut IDLE/PushSubscription, dernier delta reçu, curseur `(UIDVALIDITY, lastUID)` ou `sinceState`, santé de la passerelle LLM (latence, dernier succès, taux d'erreur), dernier crash éventuel.
5. **Explorateur decision-trace** — vue simplifiée de `/runs/[id]`, filtrable par mail, par tool, par verdict. Aide à comprendre pourquoi un mail a été mal classé, en un ou deux taps.
6. **Progrès dans le temps** — courbe hebdo d'efficacité cascade (% sans LLM), précision F1 sur échantillon labellisé, drafts approuvés vs corrigés. Retour visible sur la valeur de l'agent.

**Bundle Cordis compagnon : `dsh-mail-api`.** Le cockpit ne parle pas directement à JMAP/IMAP ni aux internals DSH — il consomme une API métier exposée par un nouveau bundle. C'est la même doctrine « tout est plugin », appliquée à l'UI :

```typescript
// packages/dsh-mail-api/src/service.ts
export interface MailAgentAPI {
  listPending(bucket: 'important' | 'drafts' | 'newsletters' | 'review'): Promise<PendingItem[]>
  approveTag(mailId: string, tag: string): Promise<void>
  correctTag(mailId: string, oldTag: string, newTag: string): Promise<void>  // → patterns
  approveDraft(draftId: string, edits?: string): Promise<void>
  rejectDraft(draftId: string, reason?: string): Promise<void>
  markVip(email: string): Promise<void>
  unsubscribe(newsletterId: string): Promise<void>
  systemHealth(): Promise<HealthSnapshot>
  streamDecisionTraces(): AsyncIterable<DecisionTrace>  // WebSocket
  streamNotifications(): AsyncIterable<AgentEvent>      // WebSocket, push VIP
}
```

Exposition HTTP+WebSocket sur `127.0.0.1:3090` (bind local strict, jamais `0.0.0.0`), puis servi via `tailscale serve` pour l'accès tailnet. Auth par token DSH partagé, stocké dans le trousseau iOS/macOS côté client et dans `dsh-secrets` côté serveur.

**Notifications actives natives** — grâce à React Native + Expo Notifications, les mails VIP déclenchent une notification push native sur iPhone (« Sarah t'a écrit, brouillon prêt, valider ? »), tap = ouverture directe sur le draft dans le cockpit. Beaucoup plus fluide que le mail auto-adressé de la V1.

**Charge estimée V2 :** ~3-4 semaines
- Bundle `dsh-mail-api` (REST + WebSocket, auth token, tests) : 1 semaine
- Cockpit React Native (5-6 écrans, navigation, appels API, WebSocket, notifications push) : 2-3 semaines
- Déploiement Tailscale Serve + build EAS TestFlight : 2-3 jours

**Effet secondaire pour l'article (§10).** Le cockpit devient une **démonstration concrète** que DSH n'est pas prisonnier de sa web UI : n'importe qui peut brancher son propre front parce que l'API métier est un bundle Cordis exposant un service typé, exactement comme tout le reste. Renforce la thèse « tout est plugin, y compris l'UI ».

**Positionnement dans l'écosystème LINAGORA.** Ce cockpit React Native peut, plus tard, mutualiser des composants avec Twake (réutilisation du design system, briques de notifications, gestion de token). Pas un objectif V2 mais une option ouverte pour V3.

### 9.2 Autres pistes V2

- **Journal d'événements + graphe de connaissances** — ajouter comme deux bundles Cordis opt-in (`dsh-mail-events`, `dsh-mail-graph`) pour rejouabilité et corrélation calendrier/contacts.
- **Deuxième verticale (calendar, contacts)** — mêmes principes, événements JMAP standards, tools `summarize_meeting`, `draft_followup`. Le cockpit React Native étend naturellement ses écrans pour couvrir ces verticales.
- **Extension native dans un client mail** (V3) — extension Apple Mail (MailKit), Thunderbird, ou intégration Twake Mail qui affiche tags Sentinel et drafts directement dans le client habituel. Beaucoup plus lourd à développer et dépendant du client cible — à garder pour V3 si le projet trouve son public.

---

## 10. Article public — « Ce que l'on peut réellement faire avec DeepSeek Harness »

Ce projet est le vecteur d'un article destiné à ton audience (LinkedIn, blog LINAGORA, ou publication indépendante). L'angle proposé :

**Titre de travail :** « J'ai réécrit mon agent mail sur DeepSeek Harness : ce que ça change vraiment »

**Thèse en une phrase :** DSH n'est pas juste un runtime d'agent de plus — c'est le premier harnais où la boucle, les outils, la persistence et l'UI sont **réellement remplaçables par configuration**, ce qui rend viable la construction d'agents verticalisés souverains.

**Structure d'article (à valider) :**

1. **Le problème du harnais monolithique** — pourquoi LangGraph, AutoGen, CrewAI, etc. finissent par forker plutôt qu'étendre. Point commun : la boucle est du code, pas une configuration.
2. **Ce que DSH change** — « everything is a plugin », profil = composition, bundle = distribution, patch = override auditable. Illustré par le fait qu'on remplace le loop standard par une cascade mail sept nœuds sans modifier une ligne du core.
3. **Le mode Creator comme atelier** — expérience concrète : écrire les plugins depuis DSH lui-même, tester en mémoire, matérialiser en bundle. Ce que ça permet, où ça devient dangereux (shell-level trust).
4. **Piloter DSH depuis Claude Code** — pourquoi la meilleure combinaison n'est pas « tout DSH » ou « tout Claude Code » mais un partage clair : Claude Code pour bootstrap, infra, tests, refactos ; Creator mode pour plugins Cordis, prompts, validation live. Retours d'expérience concrets sur les frictions et les succès.
5. **Souveraineté par endpoint, pas par localisation** — pourquoi le modèle « passerelle OpenAI-compatible sur infra LINAGORA/OVH avec Mistral-Small-24B FP8 » donne plus de garanties concrètes qu'une inférence « locale sur mon laptop » : disponibilité 24/7, sécurité opérationnelle professionnelle, réversibilité par simple `base_url`. Introduction du flag `trusted_endpoints_only`.
6. **JMAP ou IMAP : deux adapters, un contrat** — comment un service Cordis abstrait avec deux adapters (JMAP et IMAP+SMTP) permet de basculer par simple config, sans toucher aux tools LLM. Réduction concrète des barrières d'adoption : Gmail, iCloud, Dovecot, James, Fastmail — tout se branche.
7. **Le test grandeur nature** — la boîte mail réelle de l'auteur, cascade, digests, drafts, désabonnement. Chiffres du Phase 7 : cascade 60%+ sans LLM, comparaison de plusieurs modèles de la même passerelle (variantes Mistral-Small, Mistral-Large si exposé) sur 500 mails, latence bout-en-bout et coût réel par mail traité.
8. **Ce que ça ouvre pour la souveraineté** — un harnais interopérable + endpoint OpenAI-compat paramétrable + topologie distribuée maison = déploiement local **sans dépendance à une pile agentique unique**, adapté aux entreprises et administrations européennes.
9. **Limites honnêtes** — v0.1 preview, ergonomie encore rugueuse, écosystème de bundles naissant, courbe d'apprentissage Cordis, dépendance à la disponibilité de l'endpoint LLM.
10. **Le code est ouvert** — lien vers `mmaudet/dsh-mail-agent`, invitation à contribuer et à publier d'autres verticales (calendar, tasks, docs).
11. **(Post-V2, si le cockpit RN est livré)** — « Remplacer la web UI DSH par un cockpit métier React Native » : démonstration complémentaire que même l'UI est remplaçable parce que l'API métier est un bundle Cordis. Capture d'écran de l'inbox agent iOS, validation d'un draft en un tap, notification push VIP native.

**Timing :** publier après la Phase 7 (Multi-modèles A/B), qui fournit les chiffres décisifs et le comparatif de modèles.

**Angle éditorial :** critique bienveillante, technique mais accessible, avec captures d'écran de `/runs/[id]` et extraits de `cordis.patch.yml` pour rendre concret le « tout est plugin ».

---

## 11. Prochaines étapes concrètes

1. **Créer le repo `mmaudet/dsh-mail-agent`** (public, MIT, README d'intention pointant vers ce PRD) — avec Claude Code sur le MacBook.
2. **Provisionner Athena** — Node.js 22, pnpm, Tailscale déjà en place, clone DSH + build, création des profils `mail-agent-dev` et `mail-agent-prod`, stub de l'unit systemd. Piloter avec Claude Code via SSH.
3. **Déposer le secret bearer sur Athena** — `MAIL_SENTINEL_API_KEY` dans `dsh-secrets`, jamais dans git. Test `curl` bearer sur la passerelle validé le 28 août 2026.
4. **Câbler `dsh-llm-openai`** — quatre niveaux (`economy`, `default`, `chat`, `draft`) pointés sur `chat.lucie.ovh.linagora.com/v1/`, modèle `openai/Mistral-Small-3.2-24B-Instruct-2506-FP8`, flag `trusted_endpoints_only` activé.
5. **Copier la config OIDC** du prototype précédent (`client_id`, `redirect_uri`, issuer) dans le premier `cordis.patch.yml` du profil `mail-agent-dev` — aucun ticket SSO.
6. **Ouvrir la première session Creator mode** via SSH tunnel vers Athena, contre un serveur mail de test (Apache James local sur Athena, Dovecot Docker, ou boîte Gmail dédiée). Jamais contre ta boîte perso avant la Phase 3.
7. **Commencer une note « article DSH »** en parallèle du code : capturer les surprises, les frictions et les moments « ah, c'est ça qu'ils voulaient dire » — matière brute pour l'article de fin de POC, en particulier autour de la double approche Claude Code + Creator mode et de la topologie distribuée.

---

## Références

Sources externes consultées pour la conception :

- [DeepSeek Harness — README GitHub](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness — Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness — AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md)
- [DeepSeek Harness developer preview — deepseek.com](https://deepseek.com/harness/en/)
- [DeepSeek Harness Creator Mode: How It Works & Risks — agentspulse](https://agentspulse.github.io/tutorials/deepseek-harness-creator-mode/)
- [Cordis tutorial — deepseek-harness.github.io](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/)
- [DeepSeek Harness modes — deepseek-harness.app](https://deepseek-harness.app/modes)
- [Choose the right Cordis extension seam — dev.to](https://dev.to/ahab_indieseek/deepseek-harness-everything-is-a-plugin-choose-the-right-cordis-extension-seam-4773)
- [DeepSeek Harness: Install & Add Plugins — atoms.dev](https://atoms.dev/blog/deepseek-harness)
- [How to run DSH web on a remote server — dshdocs](https://dshdocs.com/faqs/how-to-run-dsh-web-on-a-remote-server/)
- [Deploy DSH web UI on a VPS — SSD Nodes](https://www.ssdnodes.com/blog/deploy-deepseek-harness-web-ui-vps/)
- [ACP protocol and agent communication — DeepWiki](https://deepwiki.com/deepseek-ai/deepseek-harness/7.1-acp-protocol-and-agent-communication)
- [ACP automation server — DeepSeek Harness Docs](https://deepseek-harness.github.io/deepseek-harness/en/develop/acp-server/)

Références internes (enseignements du prototype précédent) :

- Cascade sept nœuds et JMAP réduit
- Prefilter rspamd et calibration réelle
- Style par owner rafraîchi depuis `Sent`
- Boucle d'apprentissage sous flag
- Decision-trace et vue `/runs/[id]`
- Health check hebdo des patterns
- Suite E2E rejouable
