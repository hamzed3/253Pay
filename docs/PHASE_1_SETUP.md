# PHASE 1 : Setup Environnement 🚀

## Objectif
Mettre en place l'infrastructure de base du backend NestJS avec Docker, configurations et structure de dossiers.

## ✅ Fichiers créés

### Configuration & Infrastructure
- ✅ `docker-compose.yml` - PostgreSQL + Redis
- ✅ `Dockerfile` - Image backend
- ✅ `.env.example` - Variables d'environnement

### NestJS Core
- ✅ `src/main.ts` - Point d'entrée
- ✅ `src/app.module.ts` - Module racine
- ✅ `src/app.controller.ts` - Controller santé
- ✅ `src/app.service.ts` - Service santé

### Configuration
- ✅ `src/config/database.config.ts` - TypeORM config
- ✅ `tsconfig.json` - Configuration TypeScript
- ✅ `package.json` - Dépendances
- ✅ `nest-cli.json` - CLI NestJS
- ✅ `.eslintrc.js` - Linting
- ✅ `.prettierrc` - Formatage
- ✅ `jest.config.js` - Tests unitaires

### Middleware & Filtres
- ✅ `src/common/filters/all-exceptions.filter.ts`
- ✅ `src/common/filters/http-exception.filter.ts`
- ✅ `src/common/interceptors/transform.interceptor.ts`

### Dossiers structure
- ✅ `src/common/decorators/`
- ✅ `src/common/guards/`
- ✅ `src/common/pipes/`
- ✅ `src/common/utils/`
- ✅ `src/database/migrations/`
- ✅ `src/database/subscribers/`

---

## 📋 Comment démarrer

### 1️⃣ Cloner et configurer

```bash
# Cloner le repo
git clone <repo-url>
cd 253Pay/backend

# Créer fichier .env (copier de .env.example)
cp .env.example .env
```

### 2️⃣ Installer les dépendances

```bash
npm install
```

**Durée** : 2-3 minutes

**Qu'est-ce qui se passe** :
- Télécharge toutes les dépendances de `package.json`
- Crée le dossier `node_modules/`
- Crée `package-lock.json`

### 3️⃣ Lancer les conteneurs Docker

```bash
docker-compose up -d
```

**Durée** : 30-60 secondes (1ère fois)

**Qu'est-ce qui se passe** :
- PostgreSQL démarre sur `localhost:5432`
- Redis démarre sur `localhost:6379`

**Vérifier** :
```bash
docker-compose ps

# Doit afficher :
# NAME                       STATUS
# 253pay-postgres           Up (healthy)
# 253pay-redis              Up (healthy)
```

### 4️⃣ Lancer le serveur NestJS

```bash
npm run dev
```

**Durée** : 3-5 secondes

**Output attendu** :
```
╔════════════════════════════════════════╗
║      🇩🇯 253PAY - Financial Platform    ║
║         Backend Server Started          ║
╠════════════════════════════════════════╣
║  Environment: development
║  Port: 3000
║  URL: http://localhost:3000
║  API Docs: http://localhost:3000/api
╚════════════════════════════════════════╝
```

---

## 🧪 Vérifications

### Health Check

Ouvre ton navigateur ou fait un `curl` :

```bash
curl http://localhost:3000/health
```

**Réponse attendue** :
```json
{
  "status": "✅ API is running",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "environment": "development"
}
```

### Swagger Documentation

Visite : **http://localhost:3000/api**

Tu devrais voir :
- ✅ "Health" section
- ✅ GET `/health` endpoint documenté

### Vérifier les conteneurs

```bash
# Voir les logs
docker-compose logs postgres
docker-compose logs redis

# Se connecter à PostgreSQL
psql -h localhost -U 253pay_user -d 253pay_db

# Ou vérifier Redis
redis-cli ping
# Réponse : PONG
```

---

## 🐛 Erreurs courantes et solutions

### ❌ Erreur : "Port 5432 already in use"

**Cause** : Autre instance PostgreSQL en cours.

**Solution** :
```bash
# Arrêter l'ancienne instance
docker-compose down

# Supprimer les données (optionnel)
docker-compose down -v

# Redémarrer
docker-compose up -d
```

### ❌ Erreur : "Cannot connect to database"

**Cause** : PostgreSQL pas encore prêt.

**Solution** :
```bash
# Attendre la santé du conteneur
docker-compose logs postgres

# Quand tu vois "database system is ready to accept connections"
# Relance npm run dev
```

### ❌ Erreur : "npm ERR! 404"

**Cause** : Dépendance non trouvée (réseau, typo).

**Solution** :
```bash
# Vider le cache npm
npm cache clean --force

# Réinstaller
rm -rf node_modules package-lock.json
npm install
```

### ❌ Erreur : "EADDRINUSE: address already in use :::3000"

**Cause** : Autre processus sur le port 3000.

**Solution** :
```bash
# Trouver le PID
lsof -i :3000

# Tuer le processus
kill -9 <PID>

# Redémarrer
npm run dev
```

---

## 📁 Structure créée

```
backend/
├── src/
│   ├── main.ts                    ← Point d'entrée
│   ├── app.module.ts              ← Module root
│   ├── app.controller.ts          ← GET /health
│   ├── app.service.ts             ← Logique métier
│   │
│   ├── config/
│   │   └── database.config.ts     ← Config TypeORM
│   │
│   ├── common/
│   │   ├── filters/               ← Exception handling
│   │   ├── interceptors/          ← Logging, transform
│   │   ├── guards/                ← Auth (à venir)
│   │   ├── decorators/            ← Custom (à venir)
│   │   ├── pipes/                 ← Validation (à venir)
│   │   └── utils/                 ← Helpers (à venir)
│   │
│   └── database/
│       ├── migrations/            ← SQL migrations
│       └── subscribers/           ← Auto-update listeners
│
├── package.json                   ← Dépendances
├── tsconfig.json                  ← TypeScript config
├── jest.config.js                 ← Tests config
├── .eslintrc.js                   ← Linting
├── .prettierrc                    ← Format code
��── docker-compose.yml             ← Services
├── Dockerfile                     ← Image
└── .env.example                   ← Vars template
```

---

## ⚙️ Commandes utiles

```bash
# Développement
npm run dev           # Watch mode
npm run build         # Build production
npm run prod          # Run production build

# Linting
npm run lint          # Check + fix code style

# Tests (à venir)
npm test              # Run tests
npm run test:watch    # Watch mode
npm run test:cov      # Coverage

# Migrations (à venir)
npm run migration:generate  # Create migration
npm run migration:run       # Run migrations
npm run migration:revert    # Revert last

# Docker
docker-compose up -d        # Démarrer
docker-compose logs -f      # Voir logs
docker-compose down         # Arrêter
docker-compose down -v      # Arrêter + supprimer données
```

---

## 🎯 Prochaine étape : PHASE 2

Une fois que tu as :
- ✅ npm run dev fonctionnant
- ✅ GET /health retournant 200
- ✅ Swagger disponible à /api

Dis-moi **"PHASE 2"** et nous créerons :
- Schéma de base de données complet
- Migrations TypeORM
- Seeders pour données de test

---

## 📚 Ressources

- [NestJS Docs](https://docs.nestjs.com)
- [TypeORM Docs](https://typeorm.io)
- [PostgreSQL Docs](https://www.postgresql.org/docs)
- [Docker Compose Docs](https://docs.docker.com/compose)

---

## ✅ Checklist complète

- [ ] `npm install` fait
- [ ] `.env` créé depuis `.env.example`
- [ ] `docker-compose up -d` OK (2 conteneurs sains)
- [ ] `npm run dev` marche sans erreurs
- [ ] `curl http://localhost:3000/health` retourne 200
- [ ] Swagger accessible à `http://localhost:3000/api`
- [ ] Code formaté avec `npm run lint`

Une fois cette checklist complète, nous avançons ! 🚀
