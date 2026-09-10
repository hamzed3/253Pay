# PHASE 4 — Wallet et ledger

> État : **terminée**. Le portefeuille est créé à l'inscription, le moteur
> d'écriture comptable fonctionne sous verrou, le solde et le relevé sont
> consultables, et la réconciliation détecte tout écart.
> 52 tests unitaires, 66 tests d'intégration.
>
> Aucune route ne déplace encore d'argent : les transferts sont la PHASE 5.

---

## 1. La correction

En écrivant cette phase, j'ai trouvé une contradiction entre deux documents du
projet. Il faut la connaître, parce qu'elle touche au sens même des chiffres.

`architecture.md` (section 5) présentait ce transfert :

| Compte | Débit | Crédit |
|---|---|---|
| Wallet A (payeur) | | 5 050 |
| Wallet B (bénéficiaire) | 5 000 | |
| Revenus 253Pay | 50 | |

Le payeur est **crédité** quand il se vide, et les produits **augmentent au
débit**. Or le schéma de la PHASE 2 type les portefeuilles clients en
`LIABILITY` avec la mention « le CRÉDIT augmente le compte ». Les deux ne
peuvent pas être vrais en même temps.

### Ce que le code applique

Chaque type de compte a un **sens naturel** : celui dans lequel il augmente.

| Type | Augmente au | Exemple |
|---|---|---|
| `ASSET` — ce que nous possédons | DÉBIT | `SYSTEM_CASH` |
| `EXPENSE` — ce que nous dépensons | DÉBIT | commissions versées |
| `LIABILITY` — ce que nous devons | CRÉDIT | **portefeuille client** |
| `REVENUE` — ce que nous gagnons | CRÉDIT | `SYSTEM_REVENUE` |
| `EQUITY` — fonds propres | CRÉDIT | capital |

Le même transfert devient :

| Compte | Débit | Crédit | Effet |
|---|---|---|---|
| Wallet A (payeur) | 5 050 | | notre dette envers lui diminue |
| Wallet B (bénéficiaire) | | 5 000 | notre dette envers lui augmente |
| Revenus 253Pay | | 50 | notre produit augmente |
| **Total** | **5 050** | **5 050** | |

### Pourquoi cette convention plutôt que l'autre

- C'est la comptabilité standard, celle qu'attendent un auditeur et la Banque
  Centrale. Sur un dossier d'agrément, ce n'est pas un détail.
- Elle rend structurellement visible que **l'argent des clients n'est pas notre
  chiffre d'affaires** : il est au passif, pas au produit.
- Elle était déjà celle du schéma de base de données.

`architecture.md` a été corrigé, avec une note signalant le changement. La
règle vit désormais dans **une seule fonction** :
`computeBalance()`, dans `src/modules/ledger/ledger.rules.ts`.

> ⚠️ Le piège à connaître : appliquer « débit moins crédit » à tous les comptes.
> Tout client ayant de l'argent afficherait alors un solde **négatif**.

---

## 2. Le moteur : `LedgerService.post()`

C'est le seul endroit du projet où de l'argent bouge. L'ordre des opérations
n'est pas négociable :

```
1. valider l'équilibre           AVANT de toucher la base
2. verrouiller les comptes       par UUID croissant
3. recalculer les soldes réels   depuis le ledger, sous le verrou
4. vérifier la provision         ici, et nulle part ailleurs
5. écrire transaction + écritures
6. rafraîchir wallets.available_minor
```

Le tout dans **une seule transaction PostgreSQL**. Tout réussit ensemble ou
échoue ensemble : il n'existe aucun instant où l'argent a quitté un compte sans
être arrivé sur un autre.

### Le verrou, et la preuve qu'il sert

Deux retraits de 10 000 FDJ arrivant en même temps sur un solde de 10 000 FDJ.
Sans verrou, les deux lisent « 10 000 », les deux acceptent.

J'ai vérifié plutôt que supposé : en retirant temporairement le `FOR UPDATE`,
le test de double dépense échoue, et les **deux** retraits passent. 10 000 FDJ
apparaissent à partir de rien. Verrou remis, un seul passe.

Un test de concurrence qui n'a jamais été vu échouer ne prouve rien.

### L'ordre de verrouillage évite l'interblocage

Deux transferts croisés, A→B et B→A, au même instant. Si chacun verrouille
d'abord son propre compte : le premier tient A et attend B, le second tient B
et attend A. Plus personne n'avance — PostgreSQL finit par tuer l'un des deux.

En verrouillant **toujours par UUID croissant**, le second attend simplement
que le premier ait fini. Le test `ne s'interbloque pas sur deux transferts
croisés` le vérifie.

### Idempotence : deux garde-fous, pas un

1. Une recherche préalable de l'`Idempotency-Key`. Elle traite le cas courant —
   le client qui réappuie après une coupure réseau — sans travail inutile.
2. L'index `UNIQUE` en base. C'est le **vrai** garde-fou : deux requêtes
   simultanées passent toutes les deux l'étape 1. PostgreSQL en rejette une, et
   le code rend alors au client la transaction créée par l'autre.

Le test `tient même si les deux requêtes arrivent exactement en même temps`
lance les deux en parallèle et vérifie qu'une seule transaction existe.

---

## 3. Les routes

Toutes protégées par un jeton. **Aucune ne déplace d'argent.**

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/wallets/me` | Mon solde |
| GET | `/api/wallets/me/statement?limit&cursor` | Mon relevé |
| GET | `/api/wallets/:id/reconciliation` | Cache contre ledger — **ADMIN** |

```bash
curl http://localhost:3000/api/wallets/me -H "Authorization: Bearer <token>"
# { "walletId": "...", "balance": { "amount": "1500000", "formatted": "15 000 FDJ" },
#   "consistent": true }
```

Deux choix d'affichage :

- Le solde renvoyé est celui du **ledger**, pas du cache. Un solde montré à un
  client doit être exact.
- Le relevé traduit `DEBIT`/`CREDIT` en `sortie`/`entrée`. Un client ne sait pas
  ce qu'est un débit — et pour un portefeuille, le débit correspond justement à
  une sortie, ce qui est contre-intuitif affiché tel quel.

---

## 4. Fichiers créés

| Fichier | Rôle |
|---|---|
| `src/modules/ledger/ledger.rules.ts` | Les règles comptables, en fonctions pures |
| `src/modules/ledger/ledger.rules.spec.ts` | 16 tests, sans base |
| `src/modules/ledger/ledger.service.ts` | Le moteur : verrous, écritures, réconciliation |
| `src/modules/wallets/wallets.service.ts` | Création, solde, relevé |
| `src/modules/wallets/wallets.controller.ts` | Les 3 routes |
| `prisma/migrations/…_transaction_reference_sequence/` | Séquence des références `TX-2026-000123` |
| `test/ledger.integration-spec.ts` | 20 tests contre PostgreSQL |

Modifié : `auth.service.ts` crée désormais le portefeuille **dans la même
transaction** que l'utilisateur. Un compte sans portefeuille serait inutilisable
et devrait être réparé à la main.

---

## 5. Les tests

```bash
npm test                    # 52 tests unitaires
npm run test:integration    # 66 tests, PostgreSQL + Redis requis
```

Ce qui est vérifié, au-delà du cas nominal :

- deux retraits simultanés sur le solde exact : **un seul** passe, le solde
  finit à zéro, jamais négatif ;
- dix opérations simultanées : aucune perte, au franc près ;
- transferts croisés A→B et B→A : les deux aboutissent, aucun interblocage ;
- rejeu d'une même `Idempotency-Key`, séquentiel **et** simultané ;
- un déséquilibre d'un franc est refusé sans consommer de numéro de référence ;
- un portefeuille gelé refuse tout mouvement ;
- un cache corrompu est détecté, et le client voit quand même le bon solde ;
- la réconciliation est refusée à un client, acceptée pour un `ADMIN` ;
- sur **tout** le grand livre, somme des débits = somme des crédits.

### Un test instable, corrigé à la racine

La suite échouait environ une fois sur trois avec un `429` inexpliqué. La cause :
la base PostgreSQL de test était recréée à chaque exécution, mais **pas Redis**.
Les délais anti-spam et compteurs de quota survivaient d'un lancement à l'autre,
et un test réutilisant un numéro moins de 60 secondes après le précédent était
refusé.

`test/global-setup.ts` vide désormais la base Redis de test, comme il recrée la
base PostgreSQL. Vérifié par 10 exécutions consécutives sans échec.

> Une suite de tests instable sur un ledger est pire qu'une suite absente : on
> finit par ignorer ses échecs, y compris les vrais.

---

## 6. Limites connues, à traiter plus tard

Elles ne bloquent aucune phase suivante, mais elles doivent être écrites :

1. **Le solde est recalculé par `SUM` à chaque opération.** C'est exact et
   simple, mais le coût croît avec le nombre d'écritures du compte. Pour un
   client, c'est négligeable. Pour `SYSTEM_CASH` après des millions
   d'opérations, il faudra des soldes figés périodiquement (PHASE 13).
2. **Les comptes système sont un point de contention.** Chaque opération avec
   frais verrouille `SYSTEM_REVENUE`, ce qui sérialise ces transactions. Cela
   suffit largement au démarrage ; à forte charge, il faudra répartir ces
   comptes.
3. **`reserved_minor` n'est pas encore utilisé.** Il servira à bloquer un
   montant en attente de confirmation (PHASE 6).
4. **Aucune tâche planifiée de réconciliation.** La méthode existe et est
   testée ; l'exécution quotidienne sur tous les portefeuilles est en PHASE 13.

---

## 7. Erreurs fréquentes

### `LEDGER_UNBALANCED` alors que le calcul semble juste

Les frais ont été oubliés côté crédit. Le payeur est débité de *montant +
frais* ; il faut donc créditer le bénéficiaire **et** `SYSTEM_REVENUE`.

### Un client affiche un solde négatif

Convention inversée quelque part : pour un portefeuille (`LIABILITY`), le solde
est `crédits − débits`. Passez toujours par `computeBalance()`.

### `Do not know how to serialize a BigInt`

Un montant `bigint` est renvoyé brut dans une réponse JSON. Tout montant sortant
de l'API passe par `Money` — c'est aussi la règle absolue n°1.

### `Solde insuffisant` alors que le cache affiche assez

Le cache ment. Appelez la route de réconciliation : le ledger fait foi.

---

## 8. Prochaine étape — PHASE 5

Transferts entre clients :

- route `POST /api/transfers` avec en-tête `Idempotency-Key` ;
- moteur de frais lisant `fee_rules` (le backend recalcule tout, il ignore les
  montants envoyés par le client) ;
- contrôle des plafonds selon le niveau KYC (`transaction_limits`) ;
- confirmation du destinataire par identité réduite (« Hamze M. ») ;
- annulation par transaction `REVERSAL`.

## Checklist

- [ ] `npm run prisma:migrate` → 3 migrations
- [ ] Inscription → `GET /api/wallets/me` renvoie `0 FDJ`
- [ ] Le compte de ledger créé est de type `LIABILITY`
- [ ] `GET /api/wallets/:id/reconciliation` → 403 pour un client, 200 pour un ADMIN
- [ ] `npm test` → 52 tests
- [ ] `npm run test:integration` → 66 tests
