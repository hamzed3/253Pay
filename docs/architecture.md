# 253Pay — Analyse et architecture

> Document préparatoire. Aucune ligne de code de production n'est encore écrite.
> Objectif : valider l'architecture avant de démarrer la PHASE 1.

---

## 1. Analyse du projet

### Ce que le projet est réellement

253Pay n'est pas « une application mobile ». C'est **trois logiciels** qui communiquent :

| Composant | Rôle | Techno |
|---|---|---|
| API backend | Le cerveau. Détient l'argent, les règles, la sécurité | NestJS + PostgreSQL |
| App mobile | Une simple vitrine de l'API | Flutter |
| Dashboard admin | Interface web de pilotage | React / Next.js |

**Règle absolue** : aucune logique financière ne vit dans l'application mobile. Un téléphone peut être rooté, décompilé, modifié. Le mobile ne fait que *demander*, le backend *décide*.

### Points d'attention avant de commencer

1. **Réglementation.** Je ne suis pas juriste, mais un service de paiement et de monnaie électronique nécessite en général un agrément de la Banque Centrale de Djibouti, ainsi qu'un dispositif de lutte contre le blanchiment. Le développement en sandbox ne pose aucun problème ; le passage à de l'argent réel exige cet agrément et un partenaire bancaire. À vérifier auprès de la BCD **avant** d'investir lourdement.

2. **Volume de travail.** Le cahier des charges représente plusieurs mois de travail. Découpé en 13 phases, c'est faisable ; en une fois, c'est impossible. Votre découpage est le bon.

3. **Devise.** Le Franc de Djibouti ne s'utilise pas avec des décimales. **Ne jamais stocker un montant en `float`.** On stocke des entiers (`BIGINT`) en unité mineure, avec un facteur ×100 pour rester extensible :
   - `1 000 FDJ` est stocké comme `100000`
   - `amount_minor = 100000`, `currency = 'DJF'`, `scale = 2`

   En informatique, `0.1 + 0.2 = 0.30000000000000004`. En finance, cela crée des écarts de caisse impossibles à réconcilier.

---

## 2. Architecture globale

```
┌─────────────┐   ┌─────────────┐   ┌──────────────┐
│ App client  │   │ App agent   │   │ Dashboard    │
│  (Flutter)  │   │  (Flutter)  │   │ admin (web)  │
└──────┬──────┘   └──────┬──────┘   └──────┬───────┘
       │        HTTPS / REST + JWT         │
       └──────────────┬────────────────────┘
                      ▼
        ┌──────────────────────────────┐
        │      API NestJS (REST)       │
        │  Guards · Validation · Rate  │
        │  limiting · Swagger          │
        ├──────────────────────────────┤
        │  Modules métier              │
        │  auth · users · wallets      │
        │  ledger · transactions       │
        │  agents · merchants · kyc    │
        ├──────────────────────────────┤
        │  Couche fournisseurs         │
        │  PaymentProvider (interface) │
        │  → MockProvider (phases 1-13)│
        │  → DMoneyProvider (futur)    │
        └───────┬──────────┬───────────┘
                │          │
        ┌───────▼───┐  ┌───▼──────┐  ┌──────────┐
        │PostgreSQL │  │  Redis   │  │ Firebase │
        │ (vérité)  │  │ OTP·file │  │   FCM    │
        └───────────┘  └──────────┘  └──────────┘
```

**Pourquoi Redis en plus de PostgreSQL ?**
PostgreSQL est la mémoire longue : l'argent, l'historique. Redis est la mémoire courte : codes OTP qui expirent en 5 minutes, compteurs de tentatives, file d'attente des notifications. Redis efface tout seul grâce au TTL.

---

## 3. Arborescence proposée

### Monorepo

```
253pay/
├── docker-compose.yml
├── .env.example
├── README.md
├── backend/          ← NestJS
├── mobile/           ← Flutter
└── admin/            ← Dashboard web (phase 11)
```

### Backend

```
backend/
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── config/                 configuration + validation des variables d'env
│   ├── common/
│   │   ├── decorators/         @CurrentUser, @Roles, @IdempotencyKey
│   │   ├── guards/             JwtGuard, RolesGuard, PinGuard
│   │   ├── interceptors/       logs, transformation des réponses
│   │   ├── filters/            gestion centralisée des erreurs
│   │   ├── money/              objet Money — jamais de float
│   │   └── errors/             codes d'erreur métier
│   ├── database/
│   │   ├── migrations/
│   │   └── seeds/
│   ├── modules/
│   │   ├── auth/               inscription, login, OTP, refresh, appareils
│   │   ├── users/              profil, statut, rôles
│   │   ├── wallets/            portefeuilles, soldes (lecture seule)
│   │   ├── ledger/             cœur comptable, écritures doubles
│   │   ├── transactions/       orchestration, statuts, idempotence
│   │   ├── transfers/          user → user
│   │   ├── deposits/           entrées d'argent
│   │   ├── withdrawals/        sorties d'argent
│   │   ├── agents/             opérations agent, commissions
│   │   ├── merchants/          QR, encaissement, règlements
│   │   ├── payments/
│   │   │   └── providers/      PaymentProvider + MockPaymentProvider
│   │   ├── kyc/                vérification d'identité
│   │   ├── fees/               moteur de frais configurable
│   │   ├── limits/             plafonds par profil
│   │   ├── notifications/      FCM + notifications internes
│   │   ├── webhooks/           réception, signature, rejeu
│   │   ├── audit/              journal des actions sensibles
│   │   └── admin/              endpoints du dashboard
│   └── jobs/                   tâches planifiées (réconciliation, expirations)
└── test/
```

### Mobile

```
mobile/lib/
├── main.dart
├── core/
│   ├── api/            client HTTP, intercepteurs, refresh token
│   ├── storage/        stockage sécurisé (flutter_secure_storage)
│   ├── router/         navigation
│   ├── theme/          identité visuelle 253Pay
│   ├── l10n/           fr (défaut) · so · ar · en
│   └── errors/
├── features/
│   ├── onboarding/  auth/  home/  wallet/
│   ├── transfer/  deposit/  withdrawal/
│   ├── merchant/  history/  profile/  kyc/
└── shared/widgets/
```

Chaque *feature* suit le même découpage : `data/` (appels API) → `domain/` (modèles, règles) → `presentation/` (écrans). Cette répétition est volontaire : on retrouve toujours un fichier au même endroit.

---

## 4. Schéma de base de données

Tables principales, colonnes essentielles seulement.

### Identité

```
users
  id UUID PK · phone UNIQUE · email NULL · first_name · last_name
  pin_hash · password_hash NULL · role (USER|AGENT|MERCHANT|ADMIN)
  status (PENDING|ACTIVE|SUSPENDED|BLOCKED|CLOSED)
  kyc_level (0|1|2) · phone_verified_at · created_at · updated_at

user_profiles
  user_id FK · birth_date · address · city · nationality · photo_url

devices
  id · user_id FK · device_id · platform · fcm_token · last_seen_at · trusted

refresh_tokens
  id · user_id FK · token_hash · device_id · expires_at · revoked_at

otps            (miroir Redis, pour l'audit)
  id · phone · code_hash · purpose · attempts · expires_at · used_at
```

### Comptabilité — le cœur

```
wallets
  id UUID PK · user_id FK · currency 'DJF' · status
  available_minor BIGINT · reserved_minor BIGINT     ← cache, jamais la vérité

ledger_accounts
  id UUID PK · owner_type (USER|AGENT|MERCHANT|SYSTEM) · owner_id NULL
  type (ASSET|LIABILITY|REVENUE|EXPENSE|EQUITY) · code UNIQUE · currency

ledger_entries
  id UUID PK · transaction_id FK · account_id FK
  direction (DEBIT|CREDIT) · amount_minor BIGINT (toujours > 0)
  balance_after_minor BIGINT · created_at
  → INSERT UNIQUEMENT. Jamais d'UPDATE, jamais de DELETE.

transactions
  id UUID PK · reference UNIQUE (ex : TX-2026-000123)
  type (DEPOSIT|WITHDRAWAL|TRANSFER|MERCHANT_PAYMENT|COMMISSION|FEE|REVERSAL)
  status (PENDING|PROCESSING|COMPLETED|FAILED|CANCELLED|REVERSED)
  amount_minor · fee_minor · currency
  initiator_id FK · source_wallet_id NULL · destination_wallet_id NULL
  provider_id NULL · provider_reference NULL
  idempotency_key UNIQUE NULL · reversal_of_id NULL
  metadata JSONB · failure_reason · created_at · completed_at
```

### Acteurs

```
agents          user_id FK · agent_code UNIQUE · float_wallet_id FK · zone · status
merchants       id · name · merchant_code · category · wallet_id FK · qr_payload · status
merchant_users  merchant_id FK · user_id FK · role (OWNER|CASHIER) · permissions JSONB
commissions     id · transaction_id FK · agent_id FK · amount_minor · rule_id · status
```

### Configuration et contrôle

```
fee_rules           id · transaction_type · user_type · min_amount · max_amount
                    fee_type (FLAT|PERCENT|TIERED) · fee_value · cap_minor · active · version

transaction_limits  id · scope (USER|AGENT|MERCHANT) · kyc_level
                    period (SINGLE|DAILY|MONTHLY) · transaction_type · max_amount_minor

payment_providers   id · code · name · status · config JSONB (chiffré) · is_sandbox

kyc_verifications   id · user_id FK · level · status · document_type
                    document_number_hash · document_url · selfie_url
                    reviewed_by · reviewed_at · rejection_reason

webhook_events      id · provider_id · event_type · external_id UNIQUE
                    signature_valid · payload JSONB · processed_at · attempts

audit_logs          id · actor_id · actor_role · action · entity_type · entity_id
                    before JSONB · after JSONB · ip · user_agent · reason · created_at

notifications       id · user_id FK · type · title · body · data JSONB · read_at · sent_at
```

### Index à ne pas oublier

```sql
CREATE UNIQUE INDEX ON users (phone);
CREATE UNIQUE INDEX ON transactions (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX ON ledger_entries (account_id, created_at DESC);
CREATE INDEX ON transactions (initiator_id, created_at DESC);
CREATE INDEX ON transactions (status) WHERE status IN ('PENDING','PROCESSING');
```

---

## 5. Le ledger en double partie, expliqué simplement

### Le problème avec `balance += amount`

```js
userA.balance -= 5000;   // exécuté
userB.balance += 5000;   // le serveur plante ici
```

5 000 FDJ viennent de disparaître, sans aucune trace de l'intention. Un solde est un **résultat**, jamais une donnée qu'on modifie directement.

### Le principe

Chaque mouvement d'argent est enregistré **deux fois** : d'où il vient (crédit) et où il va (débit). La somme des débits égale toujours la somme des crédits. Sinon, il y a un bug — et on le détecte immédiatement, avant que l'argent ne soit perdu.

### Exemple : transfert de 5 000 FDJ, 50 FDJ de frais

| Compte | Débit | Crédit |
|---|---|---|
| Wallet A | | 5 050 |
| Wallet B | 5 000 | |
| Revenus 253Pay | 50 | |
| **Total** | **5 050** | **5 050** |

Équilibré. Ces lignes sont écrites dans **une seule transaction PostgreSQL** :

```sql
BEGIN;
  SELECT ... FROM wallets WHERE id = :a FOR UPDATE;   -- verrou
  -- vérifier le solde ICI, à l'intérieur du verrou
  INSERT INTO transactions (...) VALUES (...);
  INSERT INTO ledger_entries (...) VALUES (...), (...), (...);
  UPDATE wallets SET available_minor = ... WHERE id IN (:a, :b);
COMMIT;
```

Si quoi que ce soit échoue : `ROLLBACK`. Rien ne s'est passé — ni la moitié, ni le quart. C'est l'atomicité : tout ou rien.

### Le verrou `FOR UPDATE`

Sans lui : deux retraits de 10 000 FDJ arrivent en même temps sur un solde de 10 000. Les deux lisent « solde = 10 000 », les deux acceptent, le solde tombe à −10 000. C'est la faille numéro un des wallets amateurs.

**Toujours verrouiller les portefeuilles dans le même ordre** (par UUID croissant), sinon deux transferts croisés A→B et B→A se bloquent mutuellement.

### Les comptes système

```
SYSTEM_CASH        argent réel détenu en banque / chez les partenaires
SYSTEM_REVENUE     frais encaissés par 253Pay
SYSTEM_COMMISSION  commissions dues aux agents
SYSTEM_SUSPENSE    argent en attente (dépôt initié, non confirmé)
```

Un dépôt ne crée pas d'argent : il déplace de `SYSTEM_CASH` vers le wallet du client. Le total du système reste toujours à zéro.

### Le vrai solde

`wallets.available_minor` n'est qu'un **cache de performance**. La vérité est toujours :

```sql
SELECT SUM(CASE WHEN direction='DEBIT' THEN amount_minor ELSE -amount_minor END)
FROM ledger_entries WHERE account_id = :id;
```

Une tâche quotidienne compare le cache et le ledger. Un écart déclenche une alerte.

---

## 6. Cycle de vie d'une transaction et idempotence

### Statuts

```
PENDING → PROCESSING → COMPLETED
                     ↘ FAILED
PENDING → CANCELLED
COMPLETED → REVERSED   (via une NOUVELLE transaction de type REVERSAL)
```

Un transfert interne est instantané : `PENDING → COMPLETED`. Un dépôt via partenaire passe par `PROCESSING` en attendant le webhook.

**Une transaction financière ne se supprime jamais et ne se modifie jamais après COMPLETED.** Annuler = créer une transaction inverse pointant vers l'originale (`reversal_of_id`). L'historique reste vrai pour toujours — c'est exactement ce qu'un auditeur ou un régulateur exigera.

### Idempotence — le scénario du réseau qui coupe

L'utilisateur appuie sur « Envoyer ». Le réseau coupe. Il ne sait pas si l'argent est parti. Il réappuie. Sans protection : **deux transferts**.

Solution : l'app génère un UUID *avant* l'envoi et le place dans l'en-tête `Idempotency-Key`. Le backend :

1. cherche cette clé dans `transactions`
2. si trouvée → renvoie la transaction existante, sans rien créer
3. sinon → crée la transaction avec cette clé

La contrainte `UNIQUE` en base est le vrai garde-fou : si deux requêtes passent la vérification en même temps, PostgreSQL en rejette une.

⚠️ La clé doit rester **la même** entre les tentatives. Si l'app en génère une nouvelle à chaque appui, la protection ne sert à rien.

---

## 7. Le système Agent

L'agent est un commerçant de quartier qui transforme du cash en solde numérique, et inversement. Son « float » est son stock d'argent électronique, pré-acheté à 253Pay.

### Dépôt client de 10 000 FDJ

Le client remet 10 000 FDJ en espèces à l'agent. En échange :

| Compte | Débit | Crédit |
|---|---|---|
| Wallet client | 10 000 | |
| Float agent | | 10 000 |
| Commission agent | 150 | |
| SYSTEM_COMMISSION | | 150 |

Le float de l'agent baisse, sa commission monte. Les espèces restent physiquement chez lui : il les déposera en banque ou les réutilisera pour les retraits.

**Le float ne peut jamais devenir négatif.** Un agent à court de float ne peut plus servir de dépôt : il doit se réapprovisionner.

### Retrait client

Opération inverse : le solde du client baisse, le float de l'agent monte, l'agent remet des espèces.

Vérifications obligatoires avant exécution :
- solde client suffisant, frais inclus
- compte client actif et non bloqué
- niveau KYC suffisant pour le montant
- plafonds journalier et mensuel non dépassés
- float agent suffisant
- agent actif

### Sécurité du modèle agent

- **Confirmation par le client** : l'agent ne doit jamais pouvoir débiter seul. Le client valide par PIN ou par un code à usage unique. Sinon, un agent malhonnête vide des comptes.
- **Recherche limitée** : chercher un numéro renvoie le prénom et l'initiale du nom (`Hamze M.`), assez pour confirmer l'identité, pas assez pour exposer les données personnelles.
- **Aucune commission avant COMPLETED.**
- **Plafonds agent** distincts, avec surveillance des schémas anormaux.

---

## 8. Fournisseurs de paiement — l'abstraction

L'erreur classique consiste à écrire le code d'un partenaire un peu partout. Le jour où il change, tout est à refaire.

```ts
export interface PaymentProvider {
  readonly code: string;
  createDeposit(dto: CreateDepositDto): Promise<ProviderResult>;
  createWithdrawal(dto: CreateWithdrawalDto): Promise<ProviderResult>;
  checkStatus(providerReference: string): Promise<ProviderStatus>;
  verifyAccount(account: string): Promise<AccountInfo>;
  handleWebhook(payload: unknown, signature: string): Promise<WebhookResult>;
}
```

Le reste de l'application ne connaît que cette interface. Aujourd'hui `MockPaymentProvider` répond ; demain `DMoneyProvider` prendra sa place **sans modifier une ligne du module transactions**.

**Aucune intégration réelle ne sera écrite** tant que vous n'aurez pas une API officielle et un accord signé.

### Webhooks

Un partenaire nous notifie qu'un dépôt a abouti. Règles :

1. **Vérifier la signature** (HMAC) avant tout traitement. Sinon, n'importe qui peut créditer un compte avec une simple requête HTTP.
2. **Idempotence** : `external_id UNIQUE`. Les partenaires renvoient souvent le même événement plusieurs fois.
3. **Répondre 200 rapidement**, traiter en file d'attente.
4. **Tout journaliser**, y compris les payloads rejetés.
5. **Ne jamais faire confiance au montant reçu** : le comparer à la transaction locale.

---

## 9. Risques de sécurité identifiés

| # | Risque | Gravité | Parade |
|---|---|---|---|
| 1 | Course sur le solde (double dépense) | Critique | `SELECT FOR UPDATE` + contrainte `CHECK (balance >= 0)` |
| 2 | Rejeu d'une requête de paiement | Critique | `Idempotency-Key` + index UNIQUE |
| 3 | Webhook falsifié | Critique | Signature HMAC + liste d'IP autorisées |
| 4 | Force brute sur le PIN (4 chiffres = 10 000 possibilités) | Critique | Argon2id, 3 essais max, blocage progressif, PIN triviaux interdits |
| 5 | Abus de l'envoi d'OTP (coût SMS) | Élevé | Limite par numéro et par IP, 6 chiffres, TTL 5 min, usage unique |
| 6 | Montant manipulé côté mobile | Critique | Le backend recalcule **tous** les montants et frais, il ignore ceux envoyés par le client |
| 7 | Escalade de privilèges | Critique | `RolesGuard` sur chaque route, jamais de rôle lu depuis le corps de la requête |
| 8 | Vol de token | Élevé | Access token 15 min, refresh avec rotation et détection de réutilisation, lié à l'appareil |
| 9 | Agent frauduleux | Élevé | Confirmation client obligatoire, plafonds, alertes |
| 10 | Secrets dans Git | Critique | `.env` dans `.gitignore` dès le premier commit |
| 11 | Arrondis en float | Élevé | Entiers uniquement |
| 12 | Fuite de données personnelles | Élevé | Recherche restreinte, chiffrement des documents KYC, numéros de pièces hachés |
| 13 | Blanchiment | Réglementaire | Plafonds par niveau KYC, détection de fractionnement, signalements |
| 14 | Perte de données | Élevé | Sauvegardes chiffrées automatiques, restauration testée |
| 15 | Journaux trop bavards | Moyen | Masquer PIN, OTP, tokens et numéros complets dans les logs |

**Trois règles à retenir :**
1. Le client ment. Toujours revalider côté serveur.
2. Le réseau échoue au pire moment. Toujours prévoir la reprise.
3. Ce qui n'est pas journalisé n'existe pas.

---

## 10. PHASE 1 — préparée, prête à démarrer

**Objectif** : un squelette qui démarre, avec base de données et documentation d'API accessibles. Aucune logique financière.

### Prérequis à installer

- Node.js 20 LTS
- Docker Desktop
- Git
- VS Code

Flutter n'est pas nécessaire avant la phase mobile.

### Ce que je créerai, dans l'ordre

1. `253pay/` avec un `.gitignore` correct (**`.env` exclu dès le premier commit**)
2. `docker-compose.yml` : PostgreSQL 16 + Redis 7 + pgAdmin
3. Projet NestJS dans `backend/`
4. `.env.example` documenté + validation des variables au démarrage (l'app refuse de démarrer si une variable manque, bien mieux qu'une panne en production)
5. Arborescence `common/`, `config/`, `modules/`
6. Objet `Money` : la classe qui interdit structurellement les erreurs d'arrondi
7. Connexion PostgreSQL et Redis
8. Gestion centralisée des erreurs + intercepteur de logs
9. Swagger sur `/api/docs`
10. `GET /health` vérifiant réellement PostgreSQL et Redis
11. ESLint, Prettier, Husky
12. Premier test automatisé
13. `README.md` avec toutes les commandes

### Vérification de fin de phase

```bash
docker compose up -d        # les conteneurs tournent
npm run start:dev           # l'API démarre
curl localhost:3000/health  # {"status":"ok","db":"up","redis":"up"}
npm test                    # tests au vert
```

Puis ouvrir `http://localhost:3000/api/docs`.

### Erreurs fréquentes anticipées

| Erreur | Cause | Solution |
|---|---|---|
| `port 5432 already in use` | PostgreSQL déjà installé localement | Changer le port hôte en 5433 |
| `ECONNREFUSED 127.0.0.1:5432` | Dans Docker, `localhost` désigne le conteneur | Utiliser le nom du service : `postgres` |
| `Cannot find module '@/...'` | Alias de chemins non configurés | Ajuster `tsconfig.json` |
| Docker ne démarre pas | Virtualisation désactivée | Activer WSL2 (Windows) |

### Durée estimée

2 à 4 heures pour un débutant, en prenant le temps de comprendre chaque étape.

---

## Décisions à valider avant de commencer

1. **ORM** : Prisma (plus simple, très bonne documentation) ou TypeORM (plus intégré à NestJS, mais plus de pièges) ? → je recommande **Prisma**.
2. **Dashboard admin** : Next.js séparé (recommandé) ou servi par NestJS ?
3. **Votre système d'exploitation** : Windows, macOS ou Linux ? Les commandes en dépendent.
4. **SMS OTP** : quel fournisseur envisagé pour Djibouti ? En sandbox, l'OTP s'affichera simplement dans la console.

---

*Répondez « COMMENCER » pour lancer la PHASE 1.*
