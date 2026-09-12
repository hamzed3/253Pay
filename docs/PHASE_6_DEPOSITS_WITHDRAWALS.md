# PHASE 6 — Dépôts et retraits

> État : **terminée**. L'argent peut enfin entrer et sortir du système, via
> l'abstraction `PaymentProvider` et son unique implémentation simulée.
> Webhooks signés, idempotents, et dont le montant est vérifié.
> 70 tests unitaires, 124 tests d'intégration.

---

## 1. Le principe : deux temps, jamais un seul

Une opération avec un partenaire extérieur n'est pas instantanée. Le traiter
comme si elle l'était est l'erreur qui coûte le plus cher.

### Dépôt — l'argent n'existe qu'une fois encaissé

| Étape | Ce qui est écrit au ledger |
|---|---|
| Le client demande à verser 10 000 FDJ | **rien** |
| Le partenaire confirme (webhook) | `SYSTEM_CASH` débité 10 000 · portefeuille crédité 10 000 |
| Le partenaire refuse | **rien** — la transaction passe à `FAILED` |

Rien n'est écrit à l'initiation, et c'est délibéré. Tant que le partenaire n'a
pas encaissé, cet argent n'existe pas chez nous : l'inscrire reviendrait à
porter dans les comptes une somme que nous ne détenons pas, et le client
pourrait dépenser un argent jamais versé.

### Retrait — l'argent sort du portefeuille tout de suite

| Étape | Ce qui est écrit au ledger |
|---|---|
| Le client demande 10 000 FDJ (frais 150) | portefeuille débité 10 150 · `SYSTEM_SUSPENSE` crédité 10 150 |
| Le partenaire a payé | `SUSPENSE` débité 10 150 · `SYSTEM_CASH` crédité 10 000 · `SYSTEM_REVENUE` crédité 150 |
| Le partenaire a échoué | `SUSPENSE` débité 10 150 · portefeuille crédité 10 150 |

L'ordre est **inverse** de celui du dépôt, pour une raison précise : si l'argent
restait dans le portefeuille pendant que le partenaire prépare le versement, le
client pourrait le dépenser une seconde fois — et nous paierions deux fois la
même somme.

En cas d'échec, les frais sont rendus aussi : le service n'a pas été rendu.

> **`SYSTEM_SUSPENSE` doit toujours revenir à zéro.** Un solde qui traîne
> signale des retraits jamais dénoués. C'est une alerte d'exploitation, à
> surveiller dès qu'il y aura du trafic réel.

Les écritures de retour s'**ajoutent** à celles du départ ; rien n'est effacé.
Un retrait échoué porte quatre écritures dont la somme est nulle. L'historique
montre l'argent parti puis revenu — c'est ce qu'un auditeur veut voir.

---

## 2. Les webhooks : la porte la plus exposée

Elle est publique et elle déclenche des mouvements d'argent. Les cinq règles du
document d'architecture sont appliquées dans cet ordre.

### a. La signature, sur le corps BRUT

Sans elle, n'importe qui connaissant l'adresse crédite le compte de son choix
avec une requête HTTP (risque n°3). HMAC-SHA256, comparaison à temps constant.

Le détail qui fait échouer la plupart des intégrations : la signature porte sur
les **octets reçus**, pas sur l'objet analysé. Re-sérialiser du JSON ne redonne
pas les mêmes octets — l'ordre des clés et les espaces changent. D'où
`rawBody: true` au démarrage de l'application, et `request.rawBody` dans le
contrôleur.

> C'est exactement l'erreur que j'ai faite en écrivant les tests : ils
> envoyaient un objet que supertest re-sérialisait, et toutes les signatures
> étaient refusées.

### b. L'idempotence, deux fois

`webhook_events.external_id` est UNIQUE. Un partenaire renvoie souvent le même
événement, et parfois **en même temps** :

- la lecture préalable traite le cas courant ;
- l'index UNIQUE tranche le cas simultané. Son refus est traduit en réponse
  200 « déjà en cours de traitement », jamais en erreur : un 409 — ou pire, une
  500 — ferait rejouer le partenaire indéfiniment pour rien.

### c. Le montant n'est jamais cru sur parole

Même signé, un message annonçant 999 999 FDJ pour un dépôt de 10 000 est refusé
(`AMOUNT_MISMATCH`). Un partenaire peut se tromper, une clé peut fuiter.

### d. Tout est journalisé, y compris les rejets

Un payload à signature invalide n'est pas un déchet : c'est la trace d'une
tentative d'intrusion, et elle est conservée dans `webhook_events` avec
`signature_valid = false`.

### e. Répondre 200 rapidement

Un doublon, un événement déjà dénoué, un événement encore en attente : tous
répondent 200 avec un statut explicite (`settled`, `already_processed`,
`already_processing`, `already_settled`, `still_pending`).

---

## 3. Aucune fausse intégration

`MockPaymentProvider` ne contacte **rien**. Il accepte la demande, renvoie une
référence, et s'arrête là — c'est ensuite le webhook qui décide du sort de
l'opération, exactement comme le ferait un vrai partenaire.

Ce choix est délibéré. Un simulateur qui confirmerait tout seul donnerait
l'illusion que les dépôts fonctionnent, alors que le chemin réellement délicat
— attente, webhook, signature, idempotence, montant à revérifier — ne serait
jamais emprunté.

De même, `verifyAccount` renvoie `valid: true` **sans nom de titulaire** :
inventer un nom serait précisément la fausse intégration que la règle n°8
interdit.

Le jour où un accord sera signé : écrire une classe implémentant
`PaymentProvider`, l'ajouter à la liste dans `payments.module.ts`, insérer sa
ligne dans `payment_providers`. Aucun autre fichier ne change.

---

## 4. Les routes

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/api/deposits/quote` | Montant remis, frais, montant crédité |
| POST | `/api/deposits` | Demander un dépôt — **`Idempotency-Key` requis** |
| GET | `/api/deposits/:id` | État d'un dépôt |
| POST | `/api/withdrawals/quote` | Montant reçu, frais, total débité |
| POST | `/api/withdrawals` | Demander un retrait — **`Idempotency-Key` + code secret** |
| GET | `/api/withdrawals/:id` | État d'un retrait |
| POST | `/api/webhooks/:providerCode` | Notification partenaire — **signature** |

Le code secret est exigé sur le retrait (de l'argent sort), pas sur le dépôt (de
l'argent entre). Comme pour les transferts, il alimente le **même compteur
d'échecs** que la connexion : sans cela, cette route deviendrait un moyen de
tester des codes sans jamais déclencher le blocage progressif.

### Simuler une confirmation en développement

Aucun partenaire n'enverra de webhook. Pour dénouer une opération soi-même :

```bash
SECRET=$(grep MOCK_PROVIDER_WEBHOOK_SECRET .env | cut -d= -f2)
BODY='{"eventId":"evt-1","eventType":"op","providerReference":"MOCK-XXXX","status":"SUCCEEDED","amountMinor":"1000000"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -X POST http://localhost:3000/api/webhooks/MOCK \
  -H "Content-Type: application/json" \
  -H "x-provider-signature: $SIG" \
  -d "$BODY"
```

`providerReference` est renvoyée par `POST /api/deposits`. `amountMinor` est en
unité mineure : 10 000 FDJ = `1000000`.

> ⚠️ `printf '%s'` et non `echo` : `echo` ajoute un saut de ligne, les octets
> signés ne seraient plus ceux envoyés.

---

## 5. Les plafonds s'appliquent maintenant dans les deux sens

Jusqu'ici, seules les opérations **sortantes** consommaient un plafond. Les
dépôts font entrer l'argent : ils consomment désormais un compteur **séparé**.

| Sens | Opérations | Pourquoi séparé |
|---|---|---|
| `OUT` | transfert, retrait | Recevoir ne doit pas consommer le plafond de sortie de celui qui reçoit, sinon on bloque son compte en lui envoyant de petites sommes |
| `IN` | dépôt | Un compte non vérifié qui encaisse sans limite est une porte d'entrée pour du blanchiment, même si l'argent ne ressort qu'au compte-gouttes |

Les valeurs sont les mêmes dans les deux sens pour l'instant. À affiner avec le
métier et la réglementation.

Les opérations **en cours** (`PROCESSING`) comptent dans le plafond, pas
seulement les terminées : sinon il suffirait de lancer dix retraits d'un coup
et de laisser le partenaire les confirmer plus tard.

---

## 6. Un changement de plan assumé : `reserved_minor`

La PHASE 5 annonçait que `wallets.reserved_minor` servirait à bloquer un montant
en attente. **Il n'est finalement pas utilisé**, et c'est un meilleur choix.

Réserver un montant dans une colonne de cache créerait un **second cache à tenir
synchronisé**, en plus de `available_minor`. Deux caches, deux occasions de
diverger, et la réconciliation devient deux fois plus compliquée.

Le compte `SYSTEM_SUSPENSE` fait le même travail **dans le ledger**, qui est la
source de vérité. Le montant en attente d'un client se lit dans ses
transactions `PROCESSING` — aucune donnée dupliquée.

La colonne reste en base ; elle servira peut-être aux pré-autorisations
marchands (PHASE 8).

---

## 7. Fichiers créés

| Fichier | Rôle |
|---|---|
| `src/modules/payments/providers/payment-provider.interface.ts` | L'abstraction |
| `src/modules/payments/providers/mock-payment.provider.ts` | Simulateur + signature HMAC |
| `src/modules/payments/provider-registry.service.ts` | Annuaire, vérifie l'état en base |
| `src/modules/payments/system-accounts.service.ts` | Comptes système, en cache mémoire |
| `src/modules/deposits/deposits.service.ts` | Dépôts, en deux temps |
| `src/modules/withdrawals/withdrawals.service.ts` | Retraits, via le compte d'attente |
| `src/modules/webhooks/webhooks.service.ts` | Signature, idempotence, montant |
| `test/cash-operations.integration-spec.ts` | 30 tests de bout en bout |

Le moteur comptable gagne trois méthodes : `openPending()` (transaction sans
écriture), `settle()` (dénouement sous verrou) et `failPending()`. `post()`
accepte un statut `PROCESSING`.

---

## 8. Erreurs fréquentes

### `WEBHOOK_SIGNATURE_INVALID` alors que le secret est le bon

Les octets signés ne sont pas ceux envoyés. Signez le corps **exact**, sans
saut de ligne ajouté, et ne laissez aucun outil re-sérialiser le JSON entre la
signature et l'envoi.

### `AMOUNT_MISMATCH`

Le montant du webhook doit être **en unité mineure** et correspondre au champ
`amount` de la transaction, hors frais. 10 000 FDJ = `1000000`.

### Mon dépôt reste `PROCESSING`

C'est normal : aucun partenaire ne confirmera. Envoyez le webhook vous-même
(voir §4).

### `INSUFFICIENT_FUNDS` sur un retrait du montant exact du solde

Les frais s'ajoutent. Avec 10 000 FDJ, on ne peut pas retirer 10 000 FDJ : il
faut 10 150 FDJ.

### `LIMIT_EXCEEDED` sur un dépôt

Depuis cette phase, les dépôts consomment un plafond d'entrée. Au niveau KYC 0,
il est de 5 000 FDJ par opération.

---

## 9. Limites connues

1. **Aucune tâche de reprise.** Une opération dont le webhook se perd reste
   `PROCESSING` indéfiniment. `checkStatus()` existe sur l'interface mais n'est
   appelé nulle part — la tâche qui interroge les opérations bloquées est en
   PHASE 13.
2. **Aucune liste d'IP autorisées** sur le webhook. La signature suffit
   aujourd'hui ; un filtrage par IP viendra avec un vrai partenaire.
3. **Le traitement est synchrone.** Le document d'architecture recommande de
   répondre 200 puis de traiter en file d'attente. Le volume actuel ne le
   justifie pas ; à revoir en PHASE 13.
4. **Aucun rapprochement de trésorerie.** `SYSTEM_CASH` reflète ce que les
   partenaires déclarent, pas un relevé bancaire réel.

---

## 10. Prochaine étape — PHASE 7

Agents : le commerce de quartier qui transforme les espèces en solde numérique.

- `float_wallet` de l'agent, qui ne peut jamais devenir négatif ;
- dépôt et retrait en espèces, avec commission de l'agent ;
- **confirmation obligatoire par le client** : un agent ne doit jamais pouvoir
  débiter seul, sinon un agent malhonnête vide des comptes ;
- recherche limitée (« Hamze M. ») et plafonds agent distincts ;
- aucune commission avant `COMPLETED`.

## Checklist

- [ ] `POST /api/deposits` → statut `PROCESSING`, solde inchangé
- [ ] Webhook non signé → `WEBHOOK_SIGNATURE_INVALID`
- [ ] Webhook signé au mauvais montant → `AMOUNT_MISMATCH`
- [ ] Webhook signé et correct → solde crédité
- [ ] Le même webhook rejoué → `already_processed`, solde inchangé
- [ ] `POST /api/withdrawals` → le solde baisse immédiatement
- [ ] `npm test` → 70 tests · `npm run test:integration` → 124 tests
