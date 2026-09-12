# 253Pay — instructions projet

Plateforme de paiement numérique (wallet) pour le marché de Djibouti.

## Qui je suis

Je suis débutant/intermédiaire en développement. Explique simplement, en
français. Pour chaque étape, indique toujours :

- où créer le fichier et quel nom lui donner
- quelle commande exécuter
- ce que le code fait
- comment vérifier que ça marche
- quelles erreurs peuvent apparaître

Ne donne jamais uniquement du code. Si une décision technique est importante,
explique brièvement les avantages et inconvénients.

## Stack

| Couche | Techno |
|---|---|
| Backend | Node.js + NestJS + TypeScript |
| Base de données | PostgreSQL 16 (via Prisma) |
| Cache / OTP / files | Redis 7 |
| Mobile | Flutter + Dart |
| Dashboard admin | Next.js (phase 11) |
| Auth | JWT + refresh token + OTP |
| Notifications | Firebase Cloud Messaging |
| Infra locale | Docker Compose |
| Tests | Jest (backend), Flutter test (mobile) |

Environnement de dev : **Windows**.

## Règles absolues

1. **Jamais de `float` pour un montant.** Toujours l'objet `Money`
   (`src/common/money/money.ts`), qui stocke des entiers `bigint` en unité
   mineure. `1 000 FDJ` = `100000n`.
2. **Jamais `balance += montant`.** Tout mouvement d'argent passe par le ledger
   en double partie : un débit + un crédit équilibrés, dans une seule
   transaction PostgreSQL, avec `SELECT ... FOR UPDATE` sur les portefeuilles.
3. **Le backend décide, le mobile affiche.** Aucune logique financière côté
   Flutter. Le serveur recalcule tous les montants et frais, et ignore ceux
   envoyés par le client.
4. **Aucune transaction financière n'est supprimée ou modifiée après
   COMPLETED.** Une annulation crée une transaction inverse (`REVERSAL`)
   pointant vers l'originale.
5. **Idempotence obligatoire** sur toute opération financière, via l'en-tête
   `Idempotency-Key` et un index UNIQUE en base.
6. **Aucun secret dans Git.** `.env` reste dans `.gitignore`. Aucune clé API,
   aucun mot de passe en dur dans le code.
7. **Aucun PIN, OTP, token ou numéro de pièce d'identité dans les logs.**
8. **Aucune fausse intégration.** Ne prétends jamais qu'une connexion avec
   D-Money, une banque ou un opérateur existe. Tant qu'il n'y a pas d'API
   officielle et d'accord signé, seul `MockPaymentProvider` est utilisé, via
   l'interface `PaymentProvider`.
9. **Ne copie jamais** le code, le design ou la marque de HooPay ni d'aucun
   concurrent. 253Pay a sa propre identité.

## Méthode de travail

Le projet avance **par phases**. Ne génère jamais tout d'un coup.

- [x] **PHASE 1** — architecture et environnement ✅ terminée
- [x] **PHASE 2** — base de données et migrations ✅ terminée
- [x] **PHASE 3** — auth et OTP ✅ terminée
- [x] **PHASE 4** — wallet et ledger ✅ terminée
- [x] **PHASE 5** — transferts ✅ terminée
- [x] **PHASE 6** — dépôts et retraits (MockProvider) ✅ terminée
- [ ] PHASE 7 — agents
- [ ] PHASE 8 — marchands et QR
- [ ] PHASE 9 — KYC
- [ ] PHASE 10 — notifications
- [ ] PHASE 11 — dashboard admin
- [ ] PHASE 12 — sécurité et tests
- [ ] PHASE 13 — préparation production

À la fin de chaque phase : explique ce qui a été créé, liste les fichiers
modifiés, donne les commandes, écris les tests, puis **attends ma validation**
avant de passer à la suite.

## État actuel

PHASES 1 à 3 livrées.

La base contient les 20 tables du projet, avec leurs contraintes et leurs
déclencheurs : le ledger est immuable, un ledger déséquilibré est rejeté au
COMMIT, un solde négatif est impossible et une transaction terminée est figée.
Les données de référence se chargent avec `npm run prisma:seed`.

L'authentification fonctionne de bout en bout : inscription par SMS, connexion
par code secret haché en Argon2id, blocage progressif, vérification des
nouveaux appareils, sessions JWT avec rotation du jeton de renouvellement et
détection de réutilisation. Les routes sont fermées par défaut (`JwtAuthGuard`
global), on les ouvre avec `@Public()`.

**Aucun opérateur SMS n'est branché** : le code se lit dans la réponse HTTP
tant que `OTP_EXPOSE_IN_RESPONSE=true` (interdit en production).

Le portefeuille est créé à l'inscription, dans la même transaction que
l'utilisateur, avec son compte de ledger de type `LIABILITY`. Le moteur
comptable (`LedgerService.post`) écrit des écritures doubles sous verrou
`FOR UPDATE`, vérifie la provision depuis le ledger et rafraîchit le cache.
Solde et relevé sont consultables ; la réconciliation cache/ledger existe.

Les transferts entre clients fonctionnent : `POST /api/transfers`, avec
en-tête `Idempotency-Key` obligatoire, confirmation par code secret, frais
calculés par le serveur depuis `fee_rules`, plafonds KYC appliqués **dans** la
transaction du ledger, et annulation par écriture inverse réservée aux
administrateurs.

Les dépôts et retraits fonctionnent via l'abstraction `PaymentProvider`, dont
la seule implémentation est `MockPaymentProvider` — qui ne contacte rien. Une
opération se fait en DEUX TEMPS : un dépôt n'écrit rien au ledger tant que le
partenaire n'a pas confirmé ; un retrait sort l'argent du portefeuille
immédiatement, vers `SYSTEM_SUSPENSE`, et ne le verse qu'à la confirmation.

Les webhooks (`POST /api/webhooks/:code`) sont publics mais signés en
HMAC-SHA256 sur le corps **brut**, idempotents par `external_id`, et leur
montant est comparé à la transaction locale avant tout mouvement.

Aucun partenaire réel n'est branché : en développement, il faut envoyer le
webhook soi-même (voir `docs/PHASE_6_DEPOSITS_WITHDRAWALS.md`, §4).

## Commandes

```bash
# Infrastructure (à la racine)
docker compose up -d          # PostgreSQL 5433 · Redis 6380 · pgAdmin 5050
docker compose ps
docker compose down

# Backend
cd backend
npm install
npm run prisma:migrate        # crée/applique les migrations
npm run prisma:seed           # données de référence (idempotent)
npm run start:dev             # http://localhost:3000

npm test                      # tests unitaires, sans base
npm run test:integration      # tests d'intégration, PostgreSQL requis
npm run lint
npm run prisma:studio         # explorateur de base
```

Vérification : `curl http://localhost:3000/health` doit renvoyer
`{"status":"ok","db":"up","redis":"up"}`.

## Structure

```
253pay/
├── docker-compose.yml
├── .env.example              (.env n'est jamais commité)
├── docs/architecture.md      document de référence complet
└── backend/
    ├── prisma/
    │   ├── schema.prisma     les 20 tables
    │   ├── migrations/       SQL versionné — jamais réécrit une fois appliqué
    │   └── seed.ts           données de référence
    ├── test/                 tests d'intégration (base jetable)
    └── src/
        ├── main.ts           helmet, CORS, validation, Swagger
        ├── app.module.ts
        ├── config/           validation des variables d'env (Joi)
        ├── bootstrap.ts      configuration partagée main.ts / tests
        ├── common/
        │   ├── money/        objet Money — à utiliser partout
        │   ├── phone/        normalisation des numéros
        │   ├── hashing/      Argon2id (PIN, OTP) et SHA-256 (jetons)
        │   ├── errors/       ErrorCode + BusinessError
        │   ├── guards/       JwtAuthGuard, RolesGuard
        │   ├── decorators/   @Public, @CurrentUser, @Roles
        │   ├── filters/      format d'erreur unique
        │   └── interceptors/ logs + masquage des champs sensibles
        ├── database/         PrismaService, RedisService
        └── modules/
            ├── health/
            ├── auth/         inscription, OTP, connexion, sessions
            ├── users/
            ├── ledger/       moteur comptable — le seul à déplacer de l'argent
            ├── wallets/      solde, relevé, réconciliation
            ├── fees/         grille tarifaire, lue en base
            ├── limits/       plafonds par niveau KYC
            ├── transfers/    envoi d'argent entre clients
            ├── payments/     interface PaymentProvider + simulateur
            ├── deposits/     entrées d'argent, en deux temps
            ├── withdrawals/  sorties d'argent, via le compte d'attente
            ├── webhooks/     notifications partenaires, signées
            └── audit/        journal des actions sensibles
```

### Authentification

- `@Public()` ouvre une route ; sans lui, elle exige un jeton.
- `@CurrentUser()` injecte l'utilisateur, `@Roles('ADMIN')` restreint l'accès.
- Le rôle est lu en base à chaque requête, jamais dans le corps de la requête.
- PIN et OTP : Argon2id (secrets devinables). Jetons : SHA-256 (512 bits
  d'aléa, rien à ralentir). Voir `src/common/hashing/hashing.service.ts`.
- Tout numéro passe par `normalizePhone()` avant d'être lu ou écrit.

### Comptabilité — la convention

Chaque compte a un **sens naturel**, celui dans lequel il augmente :

- `ASSET`, `EXPENSE` augmentent au **DÉBIT** (ex. `SYSTEM_CASH`) ;
- `LIABILITY`, `REVENUE`, `EQUITY` augmentent au **CRÉDIT**.

Le portefeuille d'un client est une `LIABILITY` : son solde est
`crédits − débits`. Ne jamais appliquer « débit moins crédit » à tous les
comptes — tout client ayant de l'argent afficherait un solde négatif.

Une seule fonction porte cette règle : `computeBalance()` dans
`src/modules/ledger/ledger.rules.ts`. Tout mouvement d'argent passe par
`LedgerService.post()`, et par lui seul.

### Contrôles métier et concurrence

Un contrôle qui lit un état puis écrit doit s'exécuter **sous le même verrou**
que l'écriture, sinon deux requêtes simultanées le passent toutes les deux.
C'est ce qui est arrivé aux plafonds : trois transferts lancés ensemble
franchissaient le plafond journalier.

`LedgerService.post()` accepte pour cela un point d'accroche `beforeWrite(tx)`,
exécuté dans sa transaction, une fois les comptes verrouillés. Tout nouveau
contrôle de ce type (plafonds, float agent, limites marchand) doit y passer.

### Opérations avec un partenaire extérieur

- Une opération en attente est `PROCESSING`. Elle se dénoue par
  `LedgerService.settle()` (avec écritures) ou `failPending()` (sans).
- Un dépôt n'écrit RIEN tant que le partenaire n'a pas confirmé : inscrire un
  argent non encaissé permettrait de dépenser ce qui n'existe pas.
- Un retrait débite le portefeuille TOUT DE SUITE, vers `SYSTEM_SUSPENSE`, sans
  quoi le client dépenserait deux fois la même somme.
- `SYSTEM_SUSPENSE` doit toujours revenir à zéro. Un solde qui traîne est une
  alerte.
- La signature d'un webhook porte sur le corps BRUT (`rawBody: true` au
  démarrage). Re-sérialiser du JSON change les octets.
- Le montant annoncé par un partenaire n'est JAMAIS cru : il est comparé à la
  transaction locale.

### Ce que la base garantit toute seule

Ces règles ne sont pas des conventions : PostgreSQL les fait respecter, même
face à une requête manuelle. Ne cherchez pas à les contourner dans le code —
elles sont là pour vous.

- une écriture de `ledger_entries` ne se modifie ni ne se supprime ;
- la somme des débits d'une transaction doit égaler la somme des crédits,
  vérifiée au COMMIT ;
- `wallets.available_minor` ne peut pas devenir négatif ;
- une transaction `COMPLETED` ne change plus, sauf pour passer à `REVERSED` ;
- une transaction ne se supprime jamais ;
- une `Idempotency-Key` ne sert qu'une fois.

## Conventions de code

- Chemins d'import via l'alias `@/` (configuré dans `tsconfig.json`).
- Un module NestJS par domaine métier, dans `src/modules/`.
- Toute erreur métier lève un `BusinessError` avec un `ErrorCode`, jamais une
  chaîne libre : le mobile doit pouvoir traduire en fr / so / ar / en.
- Toute entrée d'API passe par un DTO avec `class-validator`.
- Commentaires en français, expliquant le **pourquoi**, pas le **quoi**.
- Tests obligatoires sur toute logique financière.

## Contexte réglementaire

Le passage à de l'argent réel nécessitera un agrément de la Banque Centrale de
Djibouti et un partenaire bancaire. Tant que ce n'est pas fait, le projet reste
en **sandbox** avec `MockPaymentProvider`. Ne propose jamais de contourner cette
étape.
