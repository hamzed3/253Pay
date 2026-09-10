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
- [ ] PHASE 2 — base de données et migrations
- [ ] PHASE 3 — auth et OTP
- [ ] PHASE 4 — wallet et ledger
- [ ] PHASE 5 — transferts
- [ ] PHASE 6 — dépôts et retraits (MockProvider)
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

PHASE 1 livrée. Le backend démarre, se connecte à PostgreSQL et Redis, expose
`GET /health` et Swagger. `prisma/schema.prisma` ne contient encore aucune
table : c'est le travail de la PHASE 2.

## Commandes

```bash
# Infrastructure (à la racine)
docker compose up -d          # PostgreSQL 5433 · Redis 6380 · pgAdmin 5050
docker compose ps
docker compose down

# Backend
cd backend
npm install
npx prisma generate
npm run start:dev             # http://localhost:3000
npm test
npm run lint
```

Vérification : `curl http://localhost:3000/health` doit renvoyer
`{"status":"ok","db":"up","redis":"up"}`.

## Structure

```
253pay/
├── docker-compose.yml
├── .env.example              (.env n'est jamais commité)
├── docs/architecture.md      document de référence complet
└── backend/src/
    ├── main.ts               helmet, CORS, validation, Swagger
    ├── app.module.ts
    ├── config/               validation des variables d'env (Joi)
    ├── common/
    │   ├── money/            objet Money — à utiliser partout
    │   ├── errors/           ErrorCode + BusinessError
    │   ├── filters/          format d'erreur unique
    │   └── interceptors/     logs + masquage des champs sensibles
    ├── database/             PrismaService, RedisService
    └── modules/health/
```

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
