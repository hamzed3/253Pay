# PHASE 5 — Transferts entre clients

> État : **terminée**. Le moteur comptable de la PHASE 4 est enfin branché sur
> une vraie route. Frais calculés par le serveur, plafonds KYC appliqués,
> idempotence obligatoire, confirmation par code secret, annulation par écriture
> inverse.
> 70 tests unitaires, 95 tests d'intégration.

---

## 1. Ce que le client peut décider, et ce qu'il ne peut pas

C'est la règle absolue n°3 — *le backend décide, le mobile affiche* — rendue
concrète. Le corps d'une demande de transfert ne contient que :

```json
{ "recipientPhone": "77123456", "amount": "5000", "pin": "7391", "note": "Loyer" }
```

Pas de `fee`. Pas de `total`. Pas de `senderWalletId`. La validation étant en
mode `forbidNonWhitelisted`, un client qui tenterait d'imposer ses frais reçoit :

```json
{ "error": { "code": "VALIDATION_FAILED", "message": ["property fee should not exist"] } }
```

Il ne peut même pas essayer de négocier son tarif. C'est la parade au risque
n°6 (montant manipulé côté mobile).

---

## 2. Les routes

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/transfers/recipient?phone=` | Confirmer à qui appartient un numéro |
| POST | `/api/transfers/quote` | Simuler : montant, frais, total |
| POST | `/api/transfers` | Envoyer — **en-tête `Idempotency-Key` requis** |
| GET | `/api/transfers` | Mon historique, entrant et sortant |
| GET | `/api/transfers/limits` | Mes plafonds et ce que j'ai consommé |
| POST | `/api/transfers/:id/reverse` | Annuler — **ADMIN** |

### Parcours complet

```bash
# 1. Vérifier le bénéficiaire — identité réduite
curl "http://localhost:3000/api/transfers/recipient?phone=77555012" \
  -H "Authorization: Bearer $TOKEN"
# { "phone": "+25377555012", "displayName": "Hamze M." }

# 2. Simuler
curl -X POST http://localhost:3000/api/transfers/quote \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"recipientPhone":"77555012","amount":"5000"}'
# { "amount": "5 000 FDJ", "fee": "50 FDJ", "total": "5 050 FDJ",
#   "feeRule": "Transfert entre clients" }

# 3. Envoyer
curl -X POST http://localhost:3000/api/transfers \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"recipientPhone":"77555012","pin":"7391","amount":"5000"}'
```

> `displayName` renvoie « Hamze M. » : assez pour vérifier qu'on ne se trompe
> pas de personne, pas assez pour constituer un annuaire (risque n°12). Cette
> route reste malgré tout un moyen de savoir qui possède un compte — un
> compromis assumé, encadré par l'authentification et une limite de débit
> stricte. Sans elle, les clients enverraient de l'argent à l'aveugle.

---

## 3. La faille trouvée — et corrigée

En écrivant les tests, j'ai voulu vérifier une intuition : que se passe-t-il si
un client lance **plusieurs transferts exactement en même temps** ?

Le plafond journalier d'un compte non vérifié est de 10 000 FDJ. Trois envois
simultanés de 5 000 FDJ, lancés en parallèle :

```
RESULTAT: 3 transferts acceptés sur 3 → 15 000 FDJ pour un plafond de 10 000
```

**Cinq essais, cinq dépassements.** Chaque requête lisait le cumul du jour au
même instant — zéro — et concluait qu'il restait de la place.

C'est exactement le **fractionnement** que la réglementation anti-blanchiment
cherche à empêcher (risque n°13 du document d'architecture). Un plafond qu'on
contourne en appuyant trois fois vite n'est pas un plafond.

### La cause

Le contrôle était fait **avant** d'appeler le moteur comptable. Entre la lecture
du cumul et l'écriture, une autre requête pouvait passer.

### La correction

Le contrôle s'exécute désormais **dans** la transaction du ledger, une fois les
comptes verrouillés. `PostingInput` accepte un point d'accroche :

```ts
beforeWrite?: (tx: Prisma.TransactionClient) => Promise<void>;
```

Le ledger ne sait rien de ce que fait ce contrôle : il lui prête seulement son
verrou et son atomicité. Comme deux transferts du même client verrouillent le
même compte, ils sont examinés l'un après l'autre — le second voit le premier.

Après correction, cinq essais, cinq fois le même résultat :

```
RESULTAT: 2 transferts acceptés sur 3 → 10 000 FDJ pour un plafond de 10 000
```

Le cas est devenu un test permanent : *« tient même sur trois envois simultanés
— pas de fractionnement »*.

---

## 4. Le code secret protège l'intention

Un transfert exige le PIN. Un téléphone déverrouillé posé sur une table ne doit
pas suffire à vider un compte.

Point important : cette vérification passe par le **même compteur d'échecs** que
la connexion. Sans cela, la route de transfert deviendrait un moyen de tester
des codes secrets sans jamais déclencher le blocage progressif — il suffirait
d'enchaîner les tentatives. Le test *« alimente le MÊME compteur d'échecs que la
connexion »* vérifie qu'après trois PIN erronés sur un transfert, la
**connexion** elle-même est bloquée.

Un garde-fou doit être partagé, jamais dupliqué.

---

## 5. Les frais

Ils viennent de la table `fee_rules`, jamais du code. Pour un transfert :
1 % du montant, plancher 25 FDJ, plafond 500 FDJ.

| Montant envoyé | Frais | Pourquoi |
|---|---|---|
| 500 FDJ | 25 FDJ | 1 % = 5 FDJ, relevé au plancher |
| 5 000 FDJ | 50 FDJ | 1 % pile |
| 200 000 FDJ | 500 FDJ | 1 % = 2 000 FDJ, ramené au plafond |

Le plancher garantit qu'une petite opération reste rentable à traiter ; le
plafond évite de punir un gros montant. Tout est calculé en entiers, en points
de base — aucun flottant n'intervient.

Une règle visant explicitement un profil (`AGENT`) l'emporte sur une règle
générale ; à spécificité égale, la version la plus récente gagne. Changer un
tarif ne demande donc **aucun déploiement**.

> ⚠️ Ces valeurs restent des valeurs de départ, pas une décision commerciale.

---

## 6. Les plafonds

| Niveau KYC | Par opération | Par jour | Par mois |
|---|---|---|---|
| 0 — téléphone vérifié | 5 000 FDJ | 10 000 FDJ (5 ops) | 50 000 FDJ |
| 1 — pièce fournie | 100 000 FDJ | 300 000 FDJ (20 ops) | 1 500 000 FDJ |
| 2 — pièce vérifiée | 500 000 FDJ | 2 000 000 FDJ (50 ops) | 10 000 000 FDJ |

Seules les opérations **sortantes** comptent. Recevoir de l'argent ne consomme
pas le plafond du bénéficiaire — sinon il suffirait de lui envoyer de petites
sommes pour bloquer son compte pour la journée.

> ⚠️ **Fuseau horaire à trancher.** Les périodes sont calculées en UTC, comme
> tout ce qui est stocké en base. Djibouti étant à UTC+3, la « journée » de
> plafond commence à 3 h du matin, heure locale. À valider avec le métier avant
> la production ; le changement se fait dans `limits.rules.ts`, en un endroit.

---

## 7. L'annulation

Règle absolue n°4 : **on ne supprime ni ne modifie jamais une transaction
COMPLETED.** Annuler crée une transaction `REVERSAL` qui pointe vers
l'originale. L'historique montre le transfert, puis son annulation — c'est ce
qu'exigera un auditeur.

Trois protections :

1. **Réservée aux administrateurs.** Un client ne peut pas défaire un paiement
   qu'il a validé, sinon aucun marchand ne serait payé en confiance.
2. **Une seule fois.** `reversal_of_id` est UNIQUE en base.
3. **Jamais de compte en négatif.** Les écritures inverses débitent le
   bénéficiaire ; s'il a déjà dépensé l'argent, le contrôle de provision fait
   échouer l'annulation, et l'originale reste `COMPLETED`. On ne répare pas une
   erreur en en créant une autre.

---

## 8. Fichiers créés

| Fichier | Rôle |
|---|---|
| `src/modules/fees/fees.rules.ts` | Calcul des frais, fonctions pures |
| `src/modules/fees/fees.service.ts` | Choix de la règle en base |
| `src/modules/limits/limits.rules.ts` | Bornes des périodes, fonctions pures |
| `src/modules/limits/limits.service.ts` | Plafonds KYC et consommation |
| `src/modules/transfers/transfers.service.ts` | Orchestration du transfert |
| `src/modules/transfers/transfers.controller.ts` | Les 6 routes |
| `src/common/decorators/idempotency-key.decorator.ts` | En-tête obligatoire |
| `test/transfers.integration-spec.ts` | 29 tests de bout en bout |

Modifié : `LedgerService` accepte un point d'accroche `beforeWrite` (voir §3).

---

## 9. Erreurs fréquentes

### `property fee should not exist`

C'est voulu. Les frais sont calculés par le serveur ; le client ne les envoie
jamais. Utilisez `/api/transfers/quote` pour les afficher avant validation.

### `En-tête Idempotency-Key requis`

Toute opération financière l'exige. Générez la clé **avant** le premier envoi et
**réutilisez-la** à chaque nouvelle tentative. Une application qui en génère une
nouvelle à chaque appui annule toute la protection.

### `LIMIT_EXCEEDED` sur un petit montant

Le plafond **journalier cumulé** est atteint, pas celui de l'opération.
`GET /api/transfers/limits` montre ce qui a été consommé.

### `INSUFFICIENT_FUNDS` alors que le solde semble suffisant

Les frais s'ajoutent au montant. Avec 5 000 FDJ en poche, on ne peut pas
envoyer 5 000 FDJ : il faut 5 050 FDJ.

### `ACCOUNT_BLOCKED` après des essais de transfert

Trois codes secrets erronés bloquent le compte, y compris pour se connecter.
C'est volontaire (voir §4). Passez par `/api/auth/pin/reset`.

---

## 10. Limites connues

1. **Aucune détection de schéma anormal.** Les plafonds sont respectés, mais
   personne n'est alerté si un compte reçoit soudain vingt petits versements de
   comptes différents. La surveillance viendra en PHASE 12.
2. **Pas de notification au bénéficiaire.** Il faut consulter l'application pour
   voir l'argent arriver — c'est la PHASE 10.
3. **Un transfert est instantané et définitif.** Aucun délai de rétractation,
   aucune mise en attente au-delà d'un certain montant. À discuter avec le
   métier.

---

## 11. Prochaine étape — PHASE 6

Dépôts et retraits, avec `MockPaymentProvider` :

- interface `PaymentProvider` et son implémentation simulée ;
- dépôt : `SYSTEM_CASH` → portefeuille client, en passant par `SYSTEM_SUSPENSE`
  tant que le partenaire n'a pas confirmé ;
- retrait : contrôle de provision, puis sortie ;
- `reserved_minor` enfin utilisé, pour bloquer un montant en attente ;
- webhooks signés et idempotents (`webhook_events.external_id`).

## Checklist

- [ ] `GET /api/transfers/recipient?phone=…` → « Hamze M. »
- [ ] `POST /api/transfers/quote` → 5 000 FDJ, 50 FDJ de frais, 5 050 FDJ au total
- [ ] Un champ `fee` dans la requête → 400
- [ ] Sans `Idempotency-Key` → 400
- [ ] Trois PIN erronés → la connexion elle-même est bloquée
- [ ] `npm test` → 70 tests
- [ ] `npm run test:integration` → 95 tests
