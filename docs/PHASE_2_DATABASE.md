# PHASE 2 — Base de données et migrations

> État : **terminée**. 20 tables, 14 contraintes `CHECK`, 5 déclencheurs,
> 2 migrations, un script de données de référence idempotent et 18 tests
> d'intégration qui vérifient que la base refuse bien ce qu'elle doit refuser.
>
> Aucune logique financière côté application : c'est la PHASE 4.

Référence : section 4 de [`architecture.md`](./architecture.md).

---

## 1. L'idée centrale de cette phase

Un document qui dit « on ne modifie jamais une écriture comptable » ne protège
personne. Dans six mois, un développeur pressé écrira un `UPDATE`, et personne
ne le verra passer.

Cette phase transforme donc les règles du projet en **lois que PostgreSQL fait
respecter**. Ce n'est plus une question de discipline : les opérations
interdites échouent, y compris depuis pgAdmin, y compris en production, y
compris pour un administrateur.

| Règle du projet | Ce qui la fait respecter |
|---|---|
| Un solde ne descend jamais sous zéro | `CHECK (available_minor >= 0)` |
| Une écriture comptable ne se modifie ni ne se supprime | déclencheurs `ledger_entries_no_update` / `no_delete` |
| Débits = crédits, toujours | déclencheur différé `ledger_entries_must_balance` |
| Une transaction terminée est figée | déclencheur `transactions_freeze_completed` |
| Une transaction ne se supprime jamais | déclencheur `transactions_block_delete` |
| Une même `Idempotency-Key` ne sert qu'une fois | index `UNIQUE` |
| Un compte non vérifié a des plafonds bas | table `transaction_limits` |

---

## 2. Fichiers créés

| Fichier | Rôle |
|---|---|
| `backend/prisma/schema.prisma` | Les 20 tables et leurs relations |
| `backend/prisma/migrations/20260910102145_phase_2_schema_initial/` | Tables, index, contraintes, déclencheurs |
| `backend/prisma/migrations/20260910103000_phase_2_limits_and_fees_uniqueness/` | Deux trous d'unicité refermés |
| `backend/prisma/seed.ts` | Plan comptable, tarifs, plafonds, fournisseur MOCK |
| `backend/prisma.config.ts` | Fait lire au CLI Prisma le `.env` de la racine |
| `backend/test/global-setup.ts` | Crée une base jetable pour les tests |
| `backend/test/database-guarantees.integration-spec.ts` | 18 tests contre une vraie base |
| `backend/jest.integration.config.js` | Configuration des tests d'intégration |
| `backend/tsconfig.build.json` | Le build de production ne compile que `src/` |

---

## 3. Le déclencheur le plus important

C'est celui qui rend un ledger déséquilibré **impossible** :

```sql
CREATE CONSTRAINT TRIGGER "ledger_entries_must_balance"
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "assert_ledger_balanced"();
```

`DEFERRABLE INITIALLY DEFERRED` signifie : ne vérifie pas à chaque `INSERT`,
vérifie au moment du `COMMIT`. C'est indispensable, parce que les écritures
arrivent forcément une par une — donc temporairement déséquilibrées.

Conséquence concrète : si le moteur de frais de la PHASE 6 se trompe d'un
franc, la transaction entière est annulée avec `LEDGER_UNBALANCED`. L'argent ne
peut pas disparaître en silence. C'est bruyant, et c'est exactement ce qu'on
veut : un bug visible vaut infiniment mieux qu'une caisse fausse découverte
six mois plus tard.

---

## 4. Comment démarrer

```bash
# 1. Infrastructure (à la racine du dépôt)
docker compose up -d

# 2. Créer les tables et charger les données de référence
cd backend
npm install
npm run prisma:migrate      # crée/applique les migrations
npm run prisma:seed         # plan comptable, tarifs, plafonds

# 3. Voir le résultat
npm run prisma:studio       # interface web sur http://localhost:5555
```

### Commandes Prisma

| Commande | Ce qu'elle fait |
|---|---|
| `npm run prisma:migrate` | Crée et applique une migration (développement) |
| `npm run prisma:deploy` | Applique les migrations existantes (CI, production) |
| `npm run prisma:generate` | Régénère le client TypeScript après un changement de schéma |
| `npm run prisma:seed` | (Re)charge les données de référence — sans doublon |
| `npm run prisma:studio` | Explorateur de base |
| `npm run prisma:reset` | ⚠️ **Efface toute la base**, rejoue tout. Développement uniquement |

> `.env` vit à la racine du dépôt, pas dans `backend/`. `prisma.config.ts` le
> lui indique explicitement — sans quoi le CLI échouerait sur
> « Environment variable not found: DATABASE_URL ».

---

## 5. Les tests

### Tests unitaires — aucune base requise

```bash
npm test        # 9 tests de l'objet Money, en 2 secondes
```

### Tests d'intégration — PostgreSQL requis

```bash
npm run test:integration    # 18 tests
```

Ils créent une base **jetable** nommée `pay253_test`, y rejouent toutes les
migrations, puis vérifient que la base refuse :

- de modifier une écriture comptable ;
- d'en supprimer une ;
- de supprimer une transaction ;
- de faire revenir une transaction `COMPLETED` en arrière ;
- d'en changer le montant ;
- de valider un ledger déséquilibré ;
- un solde de portefeuille négatif ;
- une écriture de montant nul ;
- des frais négatifs ;
- deux transactions avec la même `Idempotency-Key` ;
- une annulation qui ne pointe vers rien ;
- un virement d'un portefeuille vers lui-même ;
- deux plafonds contradictoires ;
- un niveau KYC hors 0–2.

> Garde-fou : le script refuse de supprimer une base dont le nom ne se termine
> pas par `_test`. La base de développement ne peut pas être touchée par erreur.

---

## 6. Décisions à connaître

### Le solde n'est pas dans `wallets`

`wallets.available_minor` est un **cache de performance**. La vérité est la
somme des écritures du ledger :

```sql
SELECT SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END)
FROM ledger_entries WHERE account_id = :id;
```

Une tâche de réconciliation comparera les deux (PHASE 13). Tout écart est une
alerte, pas une correction silencieuse.

### Le portefeuille d'un client est une DETTE

Dans le plan comptable, un portefeuille client est de type `LIABILITY`. Cet
argent ne nous appartient pas : nous le devons. C'est précisément ce qu'un
régulateur veut voir — l'argent des clients n'est pas notre chiffre d'affaires.

### Les tarifs et les plafonds sont en base, pas dans le code

Un changement de tarif ne doit pas demander un déploiement. `fee_rules` porte
un numéro de `version` et un indicateur `active` : l'ancienne règle est
conservée, ce qui permet d'expliquer six mois plus tard pourquoi telle
transaction a coûté tel montant.

### ⚠️ Les montants du seed sont des valeurs de départ

Les tarifs (1 % sur un transfert, 1,5 % sur un retrait…) et les plafonds par
niveau KYC sont là pour que le moteur de frais ait de quoi travailler. **Ce ne
sont pas des décisions commerciales ni réglementaires.** Les plafonds réels
relèvent des textes de la Banque Centrale de Djibouti sur la monnaie
électronique et la lutte contre le blanchiment : ils devront être alignés avant
tout passage à de l'argent réel.

### Aucun utilisateur de test n'est créé

Créer un utilisateur exige de hacher un PIN en Argon2id, ce que définit la
PHASE 3. Un faux hachage aujourd'hui serait un mauvais exemple recopié demain.

### Deux limites de Prisma contournées en SQL

Prisma ne sait pas déclarer, pour PostgreSQL :

1. les **index partiels** — d'où `transactions_status_in_flight_idx` et
   `transaction_limits_all_types_key`, écrits à la main dans les migrations ;
2. les **contraintes `CHECK`** et les **déclencheurs** — écrits à la main
   également.

C'est normal et sans danger : une migration n'est que du SQL. Simplement, ces
objets ne se retrouvent pas dans `schema.prisma` — ne les supprimez pas en
croyant à un oubli.

---

## 7. Erreurs fréquentes

### « Environment variable not found: DATABASE_URL »

Le fichier `.env` n'existe pas. `cp .env.example .env` à la **racine** du dépôt.

### « LEDGER_UNBALANCED » alors que mon code semble correct

Le message donne le total des débits et celui des crédits. L'écart est presque
toujours les frais : ils doivent être crédités à `SYSTEM_REVENUE`, sinon le
débit du payeur (montant + frais) dépasse le crédit du bénéficiaire.

### « LEDGER_IMMUTABLE » lors d'une correction

C'est le comportement attendu. On ne corrige pas une écriture : on écrit une
transaction `REVERSAL` qui pointe vers l'originale.

### « Migration modified after being applied »

Une migration déjà appliquée a été éditée. On n'édite jamais une migration
appliquée : on en crée une nouvelle.

### `npm run prisma:migrate` demande une confirmation et échoue

Prisma a besoin d'un vrai terminal pour certaines confirmations. Lancez la
commande directement dans votre terminal, pas depuis un script automatisé.

---

## 8. Prochaine étape — PHASE 3

✅ Terminée. Voir [`PHASE_3_AUTH.md`](./PHASE_3_AUTH.md) : inscription par SMS,
PIN haché en Argon2id, blocage progressif, vérification des nouveaux appareils
et sessions avec rotation de jeton.

## Checklist

- [ ] `docker compose up -d` → conteneurs sains
- [ ] `npm run prisma:migrate` → 2 migrations appliquées
- [ ] `npm run prisma:seed` → 4 comptes, 1 fournisseur, 4 tarifs, 9 plafonds
- [ ] `npm run prisma:studio` → les 20 tables sont visibles
- [ ] `npm test` → 9 tests unitaires
- [ ] `npm run test:integration` → 18 tests d'intégration
- [ ] `curl http://localhost:3000/health` → `"status":"ok"`
