# 253Pay 🇩🇯

Plateforme fintech complète pour les paiements numériques au Djibouti.

## 📋 Stack Technologique

### Backend
- **Framework** : NestJS + TypeScript
- **Base de données** : PostgreSQL 14+
- **Cache/OTP** : Redis
- **Authentification** : JWT + OTP
- **Notifications** : Firebase Cloud Messaging
- **API** : REST API documentée avec Swagger

### Mobile
- **Framework** : Flutter + Dart
- **Architecture** : Clean Architecture
- **State Management** : Provider

### Infrastruct
- **Conteneurisation** : Docker + Docker Compose
- **Tests** : Jest (Backend), Flutter Testing (Mobile)

---

## 🚀 Démarrage rapide

### Prérequis
- Node.js 18+
- Docker + Docker Compose
- Git
- Dart + Flutter (pour mobile)
- VS Code ou Claude Code

### Backend

```bash
cd backend
cp .env.example .env
npm install
docker-compose up -d
npm run dev
```

L'API sera disponible sur `http://localhost:3000`
Swagger : `http://localhost:3000/api`

### Mobile

```bash
cd mobile
flutter pub get
flutter run
```

---

## 📁 Structure du projet

```
253Pay/
├── backend/              # NestJS API
│   ├── src/
│   ├── docker-compose.yml
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
│
├── mobile/               # Flutter App
│   ├── lib/
│   ├── test/
│   ├── pubspec.yaml
│   └── analysis_options.yaml
│
├── docs/                 # Documentation
│   ├── PHASE_1_SETUP.md
│   ├── DATABASE_SCHEMA.md
│   └── API_SPEC.md
│
└── README.md             # Ce fichier
```

---

## 📚 Phases de développement

- **PHASE 1** ✅ : Setup environnement
- **PHASE 2** 🔄 : Base de données + migrations
- **PHASE 3** : Authentification + OTP
- **PHASE 4** : Wallet + Ledger (cœur financier)
- **PHASE 5** : Transferts P2P
- **PHASE 6** : Dépôts/Retraits (Mock)
- **PHASE 7** : Système Agent
- **PHASE 8** : Marchands + QR
- **PHASE 9** : KYC
- **PHASE 10** : Notifications
- **PHASE 11** : Dashboard Admin
- **PHASE 12** : Sécurité + Tests
- **PHASE 13** : Production

---

## 🛠️ Commandes utiles

### Backend
```bash
cd backend
npm run dev              # Développement (watch mode)
npm run build            # Build production
npm run lint             # Linting
npm test                 # Tests
docker-compose logs -f   # Voir les logs
```

### Mobile
```bash
cd mobile
flutter run              # Lancer l'app
flutter test             # Tests
flutter build apk        # Build Android
flutter build ios        # Build iOS
```

---

## 📄 Licence

Propriétaire - 253Pay 2024
