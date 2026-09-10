# PHASE 1 — Architecture et environnement

> État : **terminée**. Le backend démarre, se connecte à PostgreSQL et Redis,
> expose `GET /health` et Swagger. Aucune logique financière, aucune table en
> base : c'est le travail de la PHASE 2.

Le document de référence complet est [`architecture.md`](./architecture.md).

---

## 1. Ce qui a été créé

### Racine du dépôt

| Fichier | Rôle |
|---|---|
| `docker-compose.yml` | PostgreSQL 16, Redis 7, pgAdmin |
| `.env.example` | Modèle de configuration. `.env` n'est **jamais** commité |
| `.gitignore` | Protège `.env`, les clés, `node_modules/`, `dist/` |
| `CLAUDE.md` | Règles du projet |
| `docs/architecture.md` | Analyse, schéma de base, ledger, sécurité |

### Backend (`backend/`)

| Fichier | Rôle |
|---|---|
| `src/main.ts` | Démarrage : helmet, CORS, validation stricte, Swagger |
| `src/app.module.ts` | Assemblage : config, limitation de débit, Prisma, Redis, health |
| `src/config/configuration.ts` | Accès typé à la configuration |
| `src/config/env.validation.ts` | Validation Joi — l'app refuse de démarrer si une variable manque |
| `src/common/money/money.ts` | **Objet `Money`** — entiers `bigint`, jamais de `float` |
| `src/common/money/money.spec.ts` | 9 tests sur les montants |
| `src/common/errors/error-codes.ts` | `ErrorCode` + `BusinessError` |
| `src/common/filters/all-exceptions.filter.ts` | Format d'erreur unique + `traceId` |
| `src/common/interceptors/logging.interceptor.ts` | Logs avec masquage des champs sensibles |
| `src/database/prisma.service.ts` | Connexion PostgreSQL |
| `src/database/redis.service.ts` | Connexion Redis |
| `src/modules/health/health.controller.ts` | `GET /health` |
| `prisma/schema.prisma` | Connexion seule — les tables arrivent en PHASE 2 |
| `tsconfig.json` | TypeScript strict, alias `@/` vers `src/` |
| `jest.config.js` | Configuration **unique** des tests |
| `eslint.config.mjs` / `.prettierrc` | Lint et formatage |

---

## 2. Démarrage

### Prérequis

Node.js 20 ou plus, Docker Desktop, Git.

### Étape 1 — configuration

```bash
cp .env.example .env
```

Puis ouvrez `.env` et remplacez au minimum `JWT_ACCESS_SECRET` et
`JWT_REFRESH_SECRET` (deux valeurs **différentes**, 32 caractères minimum) :

```bash
openssl rand -hex 32
```

> Le fichier `.env` reste à la **racine** du dépôt : il est partagé entre
> `docker-compose.yml` et le backend, qui utilisent les mêmes identifiants
> PostgreSQL. Le backend sait le lire depuis `backend/`.

### Étape 2 — infrastructure

```bash
docker compose up -d
docker compose ps
```

Attendu : `pay253-postgres` et `pay253-redis` en `Up (healthy)`, plus
`pay253-pgadmin`.

> Les ports exposés sur votre machine sont **5433** (PostgreSQL) et **6380**
> (Redis), pas les ports standard : cela évite tout conflit si vous avez déjà
> PostgreSQL ou Redis installés localement.

### Étape 3 — backend

```bash
cd backend
npm install
npx prisma generate     # obligatoire : sans cela @prisma/client n'existe pas
npm run start:dev
```

---

## 3. Vérification de fin de phase

| Commande / adresse | Attendu |
|---|---|
| `curl http://localhost:3000/health` | `{"status":"ok","db":"up","redis":"up", ...}` |
| http://localhost:3000/api/docs | Interface Swagger, section « health » |
| http://localhost:5050 | pgAdmin |
| `npm test` | 9 tests `Money` passent |
| `npm run lint` | Aucune erreur |
| `npm run build` | Compile sans erreur |

### Tester le cas dégradé

C'est le test le plus important de cette phase : un serveur qui répond « ok »
alors que sa base est tombée est plus dangereux qu'un serveur éteint.

```bash
docker compose stop redis
curl -i http://localhost:3000/health
```

Attendu : **HTTP 503**, avec le détail de la dépendance en panne :

```json
{
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Service Unavailable Exception",
    "details": { "status": "degraded", "db": "up", "redis": "down" }
  },
  "traceId": "..."
}
```

```bash
docker compose start redis    # retour à HTTP 200
```

---

## 4. Erreurs fréquentes

### « Config validation error: "DATABASE_URL" is required »

Le fichier `.env` n'existe pas encore. Faites `cp .env.example .env` à la
**racine** du dépôt (pas dans `backend/`).

### « Cannot find module '@prisma/client' »

Vous avez oublié `npx prisma generate`. Le client Prisma est généré à partir de
`prisma/schema.prisma`, il n'est pas livré tel quel par `npm install`.

### « Port 5433 already in use »

Un ancien conteneur tourne encore :

```bash
docker compose down        # ajoutez -v pour effacer aussi les données
docker compose up -d
```

### « EADDRINUSE: address already in use :::3000 »

Un autre processus occupe le port 3000. Sous Windows :

```powershell
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

### `/health` renvoie 503 avec `"db":"down"`

PostgreSQL n'a pas fini de démarrer. Vérifiez avec `docker compose logs postgres`
et attendez « database system is ready to accept connections ».

### « Multiple configurations found » au lancement de Jest

Ne réintroduisez pas de bloc `"jest"` dans `package.json` : la configuration des
tests vit uniquement dans `jest.config.js`.

---

## 5. Points d'architecture à retenir

1. **`Money` est obligatoire.** `Money.fromMajor('1000').minor === 100000n`.
   Aucun montant ne doit jamais être un `number` décimal.
2. **Toute erreur métier lève un `BusinessError`** avec un `ErrorCode`, jamais
   une chaîne libre : le mobile doit pouvoir traduire en fr / so / ar / en.
3. **Validation stricte des entrées.** `forbidNonWhitelisted` rejette tout champ
   non prévu : sur une API financière, c'est presque toujours un abus.
4. **Aucun secret dans les logs.** L'intercepteur masque `pin`, `otp`, `token`,
   `password`, `documentNumber`.
5. **Swagger est désactivé en production** (`NODE_ENV=production`).

---

## 6. Prochaine étape — PHASE 2

Base de données et migrations :

- tables `users`, `wallets`, `ledger_accounts`, `ledger_entries`, `transactions`
- contraintes d'intégrité et index (voir `architecture.md`, section 4)
- migrations Prisma et jeu de données de test

## Checklist

- [ ] `.env` créé à la racine, secrets JWT remplacés
- [ ] `docker compose ps` → conteneurs sains
- [ ] `npm install` puis `npx prisma generate` faits
- [ ] `npm run start:dev` démarre sans erreur
- [ ] `curl http://localhost:3000/health` → `"status":"ok"`
- [ ] Swagger accessible sur `/api/docs`
- [ ] `npm test` → 9 tests passent
- [ ] Cas dégradé vérifié (503 quand Redis est arrêté)
