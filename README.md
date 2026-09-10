# 253Pay — Backend

Plateforme de paiement numérique pour Djibouti.
**État : PHASE 1 — squelette technique. Aucune logique financière.**

## Démarrage rapide

```bash
# 1. Infrastructure (PostgreSQL + Redis + pgAdmin)
cp .env.example .env          # puis modifier les secrets
docker compose up -d

# 2. Backend
cd backend
npm install
npx prisma generate
npm run start:dev
```

## Vérification

| Adresse | Attendu |
|---|---|
| http://localhost:3000/health | `{"status":"ok","db":"up","redis":"up"}` |
| http://localhost:3000/api/docs | Interface Swagger |
| http://localhost:5050 | pgAdmin |

```bash
cd backend && npm test        # les tests de Money doivent passer
```

## Structure

```
253pay/
├── docker-compose.yml    PostgreSQL 16 · Redis 7 · pgAdmin
├── .env.example          modèle de configuration (.env n'est jamais commité)
└── backend/
    ├── prisma/schema.prisma
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
2. Aucune logique financière côté mobile. Le backend décide, le mobile affiche.
3. `.env` n'entre jamais dans Git.
4. Aucune transaction n'est supprimée ni modifiée après COMPLETED.
5. Aucun PIN, OTP ou token dans les logs.

## Phases

- [x] **PHASE 1** — architecture et environnement
- [ ] PHASE 2 — base de données et migrations
- [ ] PHASE 3 — authentification et OTP
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
