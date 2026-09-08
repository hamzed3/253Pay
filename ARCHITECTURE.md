# Architecture 253Pay 🇩🇯

## Vue d'ensemble

253Pay est une plateforme fintech modulaire construite avec :

```
┌─────────────────────────────────────────────────┐
│           MOBILE (Flutter)                       │
│   - User App                                     │
│   - Agent App                                    │
│   - Merchant App                                 │
└──────────────────┬──────────────────────────────┘
                   │ REST API + WebSocket
┌──────────────────▼──────────────────────────────┐
│         API GATEWAY (NestJS)                    │
│  - Authentication                               │
│  - Rate Limiting                                │
│  - Logging                                      │
└──────────────────┬──────────────────────────────┘
                   │
     ┌─────────────┼─────────────┐
     │             │             │
┌────▼────┐  ┌─────▼─────┐  ┌───▼────┐
│  Auth   │  │  Business │  │ Admin  │
│ Service │  │ Services  │  │Service │
└────┬────┘  └─────┬─────┘  └───┬────┘
     │             │            │
     └─────────────┼────────────┘
                   │
     ┌─────────────┼──────────────┐
     │             │              │
┌────▼────┐  ┌────▼────┐  ┌─────▼──┐
│PostgreSQL   │ Redis   │  │Firebase│
│  (Data)     │ (Cache) │  │  (Push)│
└────────┘  └────────┘  └────────┘
```

---

## Backend Architecture

### Modules

```
src/
├── auth/
│   ├── controllers/
│   ├── services/
│   ├── guards/
│   ├── dto/
│   ├── entities/
│   └── auth.module.ts
│
├── users/
│   ├── controllers/
│   ├── services/
│   ├── dto/
│   ├── entities/
│   ├── enums/
│   └── users.module.ts
│
├── wallets/
│   ├── controllers/
│   ├── services/
│   ├── dto/
│   ├── entities/
│   └── wallets.module.ts
│
├── ledger/
│   ├── services/
│   ├── entities/
│   └── ledger.module.ts
│
├── transactions/
│   ├── controllers/
│   ├── services/
│   ├── dto/
│   ├── entities/
│   ├── enums/
│   └── transactions.module.ts
│
├── transfers/
├── deposits/
├── withdrawals/
├── agents/
├── merchants/
├── payments/
├── kyc/
├── notifications/
├── admin/
├── audit/
├── webhooks/
│
├── common/
│   ├── filters/
│   ├── interceptors/
│   ├── guards/
│   ├── decorators/
│   ├── pipes/
│   └── utils/
│
├── config/
│   ├── database.config.ts
│   ├── jwt.config.ts
│   └── app.config.ts
│
├── database/
│   ├── migrations/
│   └── seeders/
│
└── app.module.ts
```

### Design Patterns

1. **Service Pattern** : Logique métier isolée
2. **Repository Pattern** : Accès aux données
3. **DTO Pattern** : Validation des requêtes
4. **Dependency Injection** : Gestion des dépendances
5. **Middleware Pattern** : Intercepteurs

---

## Ledger System (Double-Entry)

### Concept

Chaque transaction crée 2 entrées ledger équilibrées :

```
Transaction : User A → User B (5000 FDJ)

LedgerAccount A (DEBIT) :
  - Entry : -5000 FDJ (Type: DEBIT)
  - Reference: TRANSACTION_ID

LedgerAccount B (CREDIT) :
  - Entry : +5000 FDJ (Type: CREDIT)
  - Reference: TRANSACTION_ID

✓ Balance : 0 (Équilibre garanti)
```

### Avantages

- ✅ Intégrité financière
- ✅ Audit trail complet
- ✅ Réconciliation facile
- ✅ Transactions atomiques

---

## Transaction Flow

```
1. REQUEST
   └─ POST /transfers { to, amount, pin }

2. VALIDATION
   ├─ Vérifier PIN
   ├─ Vérifier KYC
   ├─ Vérifier limites
   └─ Vérifier solde

3. IDEMPOTENCY CHECK
   └─ Existe-t-il une transaction avec cette clé ?

4. CREATE TRANSACTION
   └─ Status: PENDING

5. CREATE LEDGER ENTRIES
   ├─ Débit du compte A
   └─ Crédit du compte B

6. UPDATE WALLET BALANCES
   ├─ A: -5000
   └─ B: +5000

7. UPDATE TRANSACTION STATUS
   └─ Status: COMPLETED

8. SEND NOTIFICATIONS
   ├─ A: "5000 envoyés"
   └─ B: "5000 reçus"

9. RESPONSE
   └─ Transaction ID + Status
```

---

## Payment Provider Architecture

```
interface PaymentProvider {
  createDeposit()
  createWithdrawal()
  checkStatus()
  handleWebhook()
}

         ↓
    ┌────┴────┐
    │          │
  MOCK      D-MONEY
 (Test)    (Production)
    │          │
    └────┬────┘
         ↓
  Same Interface
  Easy to switch
```

---

## Security Architecture

### Authentification

```
1. LOGIN
   └─ Phone + PIN

2. OTP VERIFICATION
   └─ 6 digits via SMS (Redis cached)

3. JWT TOKEN
   ├─ Access Token (15 min)
   └─ Refresh Token (7 days)

4. SESSION MANAGEMENT
   └─ Device tracking + IP logging
```

### Data Protection

```
┌─────────────────────┐
│   Sensitive Data    │
├─────────────────────┤
│ PIN         → Argon2│ (NOT stored in plain text)
│ Password    → Argon2│ (NOT stored in plain text)
│ Amount      → Audit │ (Logged with context)
│ LedgerEntry → Immut │ (Never updated/deleted)
└─────────────────────┘
```

---

## Mobile Architecture (Flutter)

### Clean Architecture Layers

```
┌─────────────────────────────────────────┐
│     PRESENTATION (UI Layer)             │
│  - Screens / Widgets                    │
│  - State Management                     │
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│     DOMAIN (Business Logic)             │
│  - Use Cases                            │
│  - Repositories (Interfaces)            │
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│     DATA (Data Source)                  │
│  - API Service                          │
│  - Local Storage                        │
│  - Database                             │
└─────────────────────────────────────────┘
```

### Features

```
lib/features/
├── auth/
│   ├── presentation/
│   ├── domain/
│   └── data/
├── home/
├── wallet/
├── transfer/
├── deposit/
├── withdrawal/
├── merchant/
├── history/
└── profile/
```

---

## Database Schema Highlights

### Key Relations

```
User (1) ──────────→ (1) Wallet
  │
  ├─→ (1) UserProfile
  ├─→ (M) UserDevice
  ├─→ (M) KYCVerification
  └─→ (M) LedgerAccount
       │
       └─→ (M) LedgerEntry

Transaction (1) ──────────→ (1) LedgerEntry (pair)
Agent (1) ──────────→ (1) User
Merchant (1) ──────────→ (1) User
```

### Indexes (Perf)

```
✓ users.phone (UNIQUE)
✓ users.email (UNIQUE)
✓ transactions.(fromUserId, toUserId, status, createdAt)
✓ ledger_entries.(ledgerAccountId, createdAt)
✓ idempotency_keys.key (UNIQUE)
✓ merchants.qrCode (UNIQUE)
```

---

## Deployment Architecture

```
DEVELOPMENT                PRODUCTION
┌──────────────┐          ┌──────────────┐
│ Docker-Compose          │ Kubernetes   │
│ - PostgreSQL            │ - Backend    │
│ - Redis                 │ - PostgreSQL │
│ - NestJS (dev)          │ - Redis      │
└──────────────┘          │ - LoadBalancer
                          └──────────────┘
```

---

## Performance Considerations

1. **Caching** : Redis pour OTP, sessions
2. **Indexes** : Créés sur les colonnes critiques
3. **Transactions atomiques** : Ledger entries
4. **Connection pooling** : PostgreSQL
5. **Rate limiting** : Protection DDoS
6. **Pagination** : Listes de transactions

---

## Testing Strategy

```
BACKEND:
├── Unit Tests (Services)
├── Integration Tests (APIs)
└── E2E Tests (Full Flow)

MOBILE:
├── Unit Tests (Models)
├── Widget Tests (UI)
└── Integration Tests (Features)
```
