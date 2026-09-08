# 🚀 Guide de Configuration Complète - 253Pay

## ✅ Prérequis

### Système d'exploitation
- Windows 10+, macOS 10.15+, ou Linux (Ubuntu 20+)

### Logiciels à installer

#### 1. Git
```bash
# Windows : https://git-scm.com/download/win
# macOS : brew install git
# Linux : sudo apt-get install git
```

#### 2. Node.js 18+ et npm
```bash
# Télécharger : https://nodejs.org/
# Vérifier l'installation
node --version  # v18.x.x
npm --version   # 9.x.x
```

#### 3. Docker Desktop
```bash
# Télécharger : https://www.docker.com/products/docker-desktop
# Après installation, vérifier :
docker --version
docker-compose --version
```

#### 4. VS Code
```bash
# Télécharger : https://code.visualstudio.com/
# Extensions recommandées :
# - ES7+ React/Redux/React-Native snippets
# - Docker
# - Thunder Client
# - PostgreSQL
```

#### 5. Flutter (pour mobile)
```bash
# Télécharger : https://flutter.dev/docs/get-started/install
# Vérifier :
flutter --version
```

---

## 📥 Étape 1 : Cloner le projet

```bash
# Cloner le repo
git clone https://github.com/hamzed3/253Pay.git
cd 253Pay

# Vérifier la structure
ls -la
```

---

## 📦 Étape 2 : Configuration de l'environnement

### Copier le fichier .env

```bash
cp .env.example .env
```

### Éditer .env (optionnel pour dev)

```bash
code .env
```

Valeurs par défaut (OK pour développement) :
```
DATABASE_USER=253pay_user
DATABASE_PASSWORD=secure_password
DATABASE_NAME=253pay_db
DATABASE_SYNCHRONIZE=true
```

---

## 🐳 Étape 3 : Démarrer Docker

### Démarrer les services (PostgreSQL + Redis)

```bash
# À partir du dossier root du projet
docker-compose up -d

# Vérifier que les services sont en cours d'exécution
docker-compose ps
```

**Résultat attendu** :
```
NAME                       STATUS
253pay-postgres           Up (healthy)
253pay-redis              Up (healthy)
```

### Vérifier les connexions

```bash
# PostgreSQL
psql -h localhost -U 253pay_user -d 253pay_db -c "SELECT version();"

# Redis
redis-cli ping
# Réponse : PONG
```

---

## 🔧 Étape 4 : Installation du Backend

### Installer les dépendances

```bash
cd backend
npm install
```

**Durée** : 2-3 minutes

### Construire le projet

```bash
npm run build
```

### Vérifier les erreurs de compilation

```bash
npm run lint
```

---

## ▶️ Étape 5 : Lancer le serveur backend

### Mode développement (Watch)

```bash
npm run dev
```

**Résultat attendu** :
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

### Tester l'API

#### Option 1 : Terminal (curl)

```bash
curl http://localhost:3000/health
```

**Réponse** :
```json
{
  "status": "✅ API is running",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "environment": "development"
}
```

#### Option 2 : Navigateur

Visite : `http://localhost:3000/health`

#### Option 3 : Swagger UI

Visite : `http://localhost:3000/api`

---

## 📱 Étape 6 : Installation du Mobile (Flutter)

### Installer les dépendances

```bash
cd mobile
flutter pub get
```

### Vérifier l'installation

```bash
flutter doctor
```

**Résultat attendu** :
```
✓ Flutter SDK
✓ Android SDK
✓ Xcode (sur macOS)
```

### Lancer l'application

#### Android

```bash
# Vous avez besoin d'un émulateur ou d'un téléphone connecté
flutter run
```

#### iOS (macOS uniquement)

```bash
flutter run
```

---

## ✅ Vérifications finales

### Backend
- [ ] `npm run dev` démarre sans erreurs
- [ ] `http://localhost:3000/health` retourne 200
- [ ] `http://localhost:3000/api` Swagger accessible
- [ ] Logs montrent le logo 253Pay

### Base de données
- [ ] PostgreSQL en cours d'exécution (port 5432)
- [ ] Redis en cours d'exécution (port 6379)
- [ ] Tables créées : `psql \dt`

### Mobile (optionnel)
- [ ] Flutter doctor : tout OK
- [ ] App lance sur émulateur/téléphone
- [ ] Écran d'accueil s'affiche

---

## 🆘 Troubleshooting

### Erreur : "Port 3000 already in use"

```bash
# Trouver le processus
lsof -i :3000

# Tuer le processus
kill -9 <PID>

# Relancer
npm run dev
```

### Erreur : "Cannot connect to database"

```bash
# Vérifier Docker
docker-compose ps

# Redémarrer
docker-compose restart postgres

# Attendre 10 secondes, puis relancer npm run dev
```

### Erreur : "npm ERR! 404 Not Found"

```bash
# Vider le cache
npm cache clean --force

# Réinstaller
rm -rf node_modules package-lock.json
npm install
```

### Erreur : Flutter - "Android SDK not found"

```bash
# Exécuter flutter doctor
flutter doctor

# Suivre les instructions pour installer
flutter doctor --android-licenses
```

---

## 📚 Commandes utiles

### Docker

```bash
# Démarrer
docker-compose up -d

# Arrêter
docker-compose down

# Logs
docker-compose logs postgres
docker-compose logs redis

# Supprimer les données
docker-compose down -v
```

### Backend

```bash
# Développement
cd backend && npm run dev

# Build
npm run build

# Tests
npm test

# Linting
npm run lint
```

### Mobile

```bash
# Lancer l'app
cd mobile && flutter run

# Build APK
flutter build apk

# Build iOS
flutter build ios

# Tests
flutter test
```

---

## 🎯 Prochaines étapes

1. ✅ Setup complet validé
2. 📖 Lire `docs/PHASE_1_SETUP.md`
3. 🔑 Lire `ARCHITECTURE.md` pour comprendre la structure
4. 🚀 Commencer PHASE 3 (Authentification)

---

## 📞 Support

Si tu rencontres une erreur :

1. Cherche dans ce guide
2. Vérifie les logs : `docker-compose logs`
3. Réessaie après 10 secondes
4. Nettoie avec `make clean`
5. Recommence depuis l'étape 3
