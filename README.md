# 253Pay — Backend

Plateforme de paiement numérique pour Djibouti.
**État : PHASE 4 — base, authentification et moteur comptable.
Aucune route ne déplace encore d'argent : c'est la PHASE 5.**

## Démarrage rapide

```bash
# 1. Infrastructure (PostgreSQL + Redis + pgAdmin)
cp .env.example .env          # puis modifier les secrets
docker compose up -d

# 2. Backend
cd backend
npm install
npm run prisma:migrate        # crée les 20 tables
npm run prisma:seed           # plan comptable, tarifs, plafonds
npm run start:dev
```

## Vérification

| Adresse | Attendu |
|---|---|
| http://localhost:3000/health | `{"status":"ok","db":"up","redis":"up"}` |
| http://localhost:3000/api/docs | Interface Swagger |
| http://localhost:5050 | pgAdmin |
| http://localhost:5555 | Prisma Studio (`npm run prisma:studio`) |
| `POST /api/auth/otp/request` | Un code de vérification (voir `devCode`) |
| `GET /api/wallets/me` | Le solde du portefeuille |

```bash
cd backend
npm test                      # 52 tests unitaires (aucune base requise)
npm run test:integration      # 66 tests contre PostgreSQL + Redis
npm run prisma:studio         # explorateur de base sur :5555
```

## Structure

```
253pay/
├── docker-compose.yml    PostgreSQL 16 · Redis 7 · pgAdmin
├── .env.example          modèle de configuration (.env n'est jamais commité)
└── backend/
    ├── prisma/
    │   ├── schema.prisma     les 20 tables
    │   ├── migrations/       SQL versionné
    │   └── seed.ts           données de référence
    ├── test/                 tests d'intégration
    └── src/
        ├── main.ts               démarrage, sécurité, Swagger
        ├── app.module.ts         assemblage des modules
        ├── config/               validation des variables d'environnement
        ├── common/
        │   ├── money/            objet Money — jamais de float
        │   ├── errors/           codes d'erreur métier
        │   ├── filters/          gestion centralisée des erreurs
        │   └── interceptors/     logs avec masquage des données sensibles
        ├── database/             connexions PostgreSQL et Redis
        └── modules/health/       GET /health
```

## Règles du projet

1. Aucun montant en `float`. Toujours l'objet `Money` (entiers `bigint`).
   Tout mouvement d'argent passe par `LedgerService.post()`, sous verrou.
2. Aucune logique financière côté mobile. Le backend décide, le mobile affiche.
3. `.env` n'entre jamais dans Git.
4. Aucune transaction n'est supprimée ni modifiée après COMPLETED.
5. Aucun PIN, OTP ou token dans les logs.
6. Les règles 1, 2 et 4 ne sont pas que des conventions : depuis la PHASE 2,
   PostgreSQL les fait respecter par contraintes et déclencheurs.

## Phases

- [x] **PHASE 1** — architecture et environnement
- [x] **PHASE 2** — base de données et migrations
- [x] **PHASE 3** — authentification et OTP
- [x] **PHASE 4** — wallet et ledger
- [ ] PHASE 5 — transferts
- [ ] PHASE 6 — dépôts et retraits (MockProvider)
- [ ] PHASE 7 — agents
- [ ] PHASE 8 — marchands et QR
- [ ] PHASE 9 — KYC
- [ ] PHASE 10 — notifications
- [ ] PHASE 11 — dashboard admin
- [ ] PHASE 12 — sécurité et tests
- [ ] PHASE 13 — préparation production
