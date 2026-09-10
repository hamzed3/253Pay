# PHASE 3 — Authentification et OTP

> État : **terminée**. Inscription par SMS, connexion par code secret, blocage
> progressif, vérification des nouveaux appareils, sessions avec rotation de
> jeton et détection de vol. 36 tests unitaires et 46 tests d'intégration.
>
> Toujours aucune logique financière : c'est la PHASE 4.

---

## 1. Les quatre décisions de cette phase

### a. Argon2id pour le PIN, SHA-256 pour les jetons

Ce n'est pas une inconséquence, c'est le cœur du raisonnement.

| Secret | Possibilités | Algorithme | Pourquoi |
|---|---|---|---|
| PIN (4 chiffres) | 10 000 | **Argon2id** | Se devine. Il faut rendre chaque essai coûteux |
| OTP (6 chiffres) | 1 000 000 | **Argon2id** | Se devine aussi |
| Refresh token | 2⁵¹² | **SHA-256** | Ne se devine pas. Ralentir ne protège de rien |

Argon2id coûte volontairement ~50 ms et 19 Mo par vérification. Avec SHA-256,
un attaquant qui vole la base retrouve tous les PIN en quelques secondes ; avec
Argon2id, il lui faut des jours **par compte**.

Inversement, un refresh token est tiré de 512 bits aléatoires : aucune attaque
par dictionnaire n'existe contre lui. Lui appliquer Argon2 n'ajouterait aucune
sécurité et ralentirait une route appelée à chaque renouvellement de session.

**La règle : ralentir le hachage protège contre la devinette. Si le secret est
indevinable, il n'y a rien à ralentir.**

### b. Tout est fermé par défaut

Le `JwtAuthGuard` est **global**. Une route est protégée sauf mention contraire
(`@Public()`). L'inverse — tout ouvert, on protège au cas par cas — laisse tôt
ou tard passer une route oubliée. Sur une API financière, cet oubli coûte cher.

Le garde recharge l'utilisateur en base **à chaque requête**. C'est une requête
SQL de plus, assumée : sans elle, un compte bloqué pour fraude continuerait
d'agir pendant les 15 minutes de validité de son jeton.

### c. La rotation des jetons, et ce qu'elle révèle

Chaque renouvellement consomme l'ancien jeton et en émet un nouveau. Si un
jeton **déjà consommé** se représente, c'est qu'il en existe une copie — donc
un vol.

On ne peut pas savoir qui, du voleur ou du client, se présente. Alors on
révoque **toute la chaîne**. Le client se reconnecte ; le voleur est dehors.

### d. Le PIN ne suffit pas depuis un appareil inconnu

Connaître le code ne permet pas de se connecter depuis un autre téléphone :
un SMS est exigé pour valider le nouvel appareil. C'est la parade concrète au
téléphone volé et au code observé par-dessus l'épaule.

---

## 2. Les routes

Toutes préfixées par `/api`. Documentation interactive : `/api/docs`.

| Méthode | Route | Protégée | Rôle |
|---|---|---|---|
| POST | `/auth/otp/request` | non | Demander un code par SMS |
| POST | `/auth/register` | non | Créer un compte après vérification |
| POST | `/auth/login` | non | Connexion numéro + code secret |
| POST | `/auth/login/verify-otp` | non | Valider un nouvel appareil |
| POST | `/auth/refresh` | non | Renouveler la session |
| POST | `/auth/logout` | non | Fermer une session |
| POST | `/auth/pin/reset` | non | Code oublié, réinitialisation par SMS |
| GET | `/auth/me` | **oui** | Profil de l'utilisateur connecté |
| POST | `/auth/pin/change` | **oui** | Changer son code secret |
| POST | `/auth/logout-all` | **oui** | Fermer toutes les sessions |

### Parcours d'inscription

```bash
# 1. Demander un code
curl -X POST http://localhost:3000/api/auth/otp/request \
  -H "Content-Type: application/json" \
  -d '{"phone":"77123456","purpose":"REGISTRATION"}'
# -> { "message": "...", "expiresInSeconds": 300, "devCode": "650101" }

# 2. Créer le compte
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"phone":"77123456","code":"650101","firstName":"Hamze","lastName":"Moussa",
       "pin":"7391","device":{"deviceId":"tel-1","platform":"ANDROID"}}'
# -> { "accessToken": "...", "refreshToken": "...", "user": { ... } }

# 3. Utiliser le jeton
curl http://localhost:3000/api/auth/me -H "Authorization: Bearer <accessToken>"
```

> `devCode` n'apparaît que si `OTP_EXPOSE_IN_RESPONSE=true`. **L'application
> refuse de démarrer avec ce réglage en production** (validation Joi).

---

## 3. Fichiers créés

| Fichier | Rôle |
|---|---|
| `src/common/hashing/hashing.service.ts` | Argon2id et SHA-256, avec le raisonnement |
| `src/common/phone/phone.ts` | Normalisation des numéros djiboutiens |
| `src/common/guards/jwt-auth.guard.ts` | Vérifie le jeton **et** le statut du compte |
| `src/common/guards/roles.guard.ts` | Contrôle des rôles |
| `src/common/decorators/public.decorator.ts` | `@Public()` |
| `src/common/decorators/roles.decorator.ts` | `@Roles('ADMIN')` |
| `src/common/decorators/current-user.decorator.ts` | `@CurrentUser()` |
| `src/modules/auth/pin.service.ts` | Force du PIN, blocage progressif |
| `src/modules/auth/otp.service.ts` | Codes SMS, quotas anti-abus |
| `src/modules/auth/token.service.ts` | Rotation et détection de réutilisation |
| `src/modules/auth/sms/sms-sender.ts` | Interface + `MockSmsSender` |
| `src/modules/auth/auth.service.ts` | Orchestration des parcours |
| `src/modules/auth/auth.controller.ts` | Les 10 routes |
| `src/modules/auth/dto/auth.dto.ts` | Validation de toute entrée |
| `src/modules/users/users.service.ts` | Accès aux comptes, vues publiques |
| `src/modules/audit/audit.service.ts` | Journal des actions sensibles |
| `src/bootstrap.ts` | Configuration partagée entre `main.ts` et les tests |

---

## 4. Les protections, et ce qu'elles arrêtent

| Attaque | Parade | Où |
|---|---|---|
| Force brute sur le PIN | Argon2id + 3 essais puis blocage 5 min → 15 min → 1 h → 24 h | `pin.service.ts` |
| PIN devinable | Refus de 1234, 0000, suites, chiffres identiques, PIN présent dans le numéro | `pin.service.ts` |
| Bombardement de SMS | Délai de 60 s par usage + 5 SMS/heure par numéro + quota par IP | `otp.service.ts` |
| OTP rejoué | Code détruit dès qu'il est utilisé, et après 3 essais ratés | `otp.service.ts` |
| Vol de jeton | Rotation + révocation de toute la chaîne à la réutilisation | `token.service.ts` |
| Téléphone volé | SMS obligatoire depuis un appareil inconnu | `auth.service.ts` |
| Annuaire des clients | Réponses identiques que le compte existe ou non | `auth.service.ts` |
| Attaque temporelle | Vérification Argon2 même sur un numéro inconnu | `auth.service.ts` |
| Escalade de privilèges | Rôle lu en base, jamais dans la requête | `roles.guard.ts` |
| Compte bloqué encore actif | Statut rechargé à chaque requête | `jwt-auth.guard.ts` |
| Fuite de secret | Aucun PIN, OTP ni jeton en clair, nulle part | partout |

### Le détail qui ne se voit pas : l'attaque temporelle

Sur une tentative de connexion avec un numéro inconnu, le code vérifie quand
même un PIN contre une empreinte factice. Sans cela, la réponse serait
instantanée pour un numéro inconnu et lente (~50 ms) pour un numéro connu. Cet
écart suffit à dresser la liste des clients de 253Pay.

---

## 5. Les tests

```bash
npm test                    # 36 tests unitaires, sans base ni Redis
npm run test:integration    # 46 tests, PostgreSQL + Redis requis
```

Les tests d'intégration montent la **vraie** application (mêmes gardes, même
validation, même format d'erreur) et l'interrogent en HTTP. C'est la raison
d'être de `src/bootstrap.ts` : avant, la configuration vivait dans `main.ts`,
que les tests ne chargent pas — ils validaient donc un pipeline différent de
celui qui tourne réellement.

Ils vérifient notamment que :

- un numéro écrit de cinq façons différentes donne **un seul** compte ;
- un code secret trop faible est refusé **sans gaspiller** le SMS ;
- un champ non prévu (`"role":"ADMIN"`) fait échouer la requête ;
- mauvais PIN et compte inexistant renvoient un message **strictement
  identique** ;
- trois codes erronés bloquent le compte, et le bon code est alors refusé ;
- un appareil inconnu déclenche un SMS même avec le bon PIN ;
- réutiliser un jeton de renouvellement ferme **toutes** les sessions ;
- changer de code secret ferme les sessions existantes ;
- le code SMS n'est jamais stocké en clair, ni en base ni dans Redis.

> **Une limite assumée** : le limiteur de débit global est neutralisé pendant
> les tests (`NODE_ENV=test`), car toutes les requêtes partent de 127.0.0.1 et
> il y voit un unique client abusif. Les quotas métier — délai entre deux SMS,
> plafond horaire par numéro — ne sont **pas** désactivés et sont testés tels
> quels. La condition ne peut jamais être vraie en production : Joi n'accepte
> que `development`, `test` ou `production` pour `NODE_ENV`.

---

## 6. Configuration

Ajouté dans `.env.example` :

```bash
OTP_LENGTH=6
OTP_TTL_SECONDS=300              # 5 minutes
OTP_MAX_ATTEMPTS=3
OTP_RESEND_COOLDOWN_SECONDS=60
OTP_MAX_PER_PHONE_PER_HOUR=5
OTP_MAX_PER_IP_PER_HOUR=20
OTP_EXPOSE_IN_RESPONSE=true      # développement uniquement
PIN_LENGTH=4
PIN_MAX_ATTEMPTS=3
```

---

## 7. Erreurs fréquentes

### « Un code de vérification vous a été envoyé » mais aucun SMS n'arrive

C'est normal : **aucun opérateur SMS n'est branché**, et il n'en existera pas
tant qu'un contrat ne sera pas signé (règle absolue n°8). Le code se lit dans
la réponse HTTP, champ `devCode`.

### `OTP_TOO_SOON` alors que je n'ai demandé qu'un code

Le délai est de 60 secondes **par numéro et par usage**. En développement, on
peut l'annuler avec `OTP_RESEND_COOLDOWN_SECONDS=0`.

### `ACCOUNT_BLOCKED` avec le bon code

Trois codes erronés ont bloqué le compte. Attendez le délai indiqué dans
`details.retryAfterMinutes`, ou passez par `/auth/pin/reset`.

### `PIN_TOO_WEAK` sur un code qui semble correct

Les suites (1234, 5678), les chiffres identiques, les codes trop courants et
tout code apparaissant dans votre propre numéro sont refusés.

### « Cannot use import statement outside a module » avec `@nestjs/jwt`

La version 12 de `@nestjs/jwt` est livrée uniquement en ESM, incompatible avec
la compilation CommonJS du projet. Restez en `^11.0.0`, cohérent avec
NestJS 11.

---

## 8. Ce qui reste à faire avant la production

Ces points ne bloquent pas les phases suivantes, mais ils devront être traités :

1. **Brancher un vrai opérateur SMS** — écrire une classe implémentant
   `SmsSender`, sous contrat. Puis passer `OTP_EXPOSE_IN_RESPONSE=false`.
2. **Confirmer les préfixes mobiles** auprès de l'opérateur
   (`DJIBOUTI_MOBILE_PREFIXES` dans `phone.ts`). Un nouveau préfixe mis en
   service bloquerait les inscriptions.
3. **Remplacer les secrets JWT** du `.env.example` par de vraies valeurs
   (`openssl rand -hex 32`), différentes l'une de l'autre.
4. **Purger les OTP expirés** de la table d'audit (tâche planifiée, PHASE 13).

---

## 9. Prochaine étape — PHASE 4

Wallet et ledger :

- création du portefeuille et de son compte de ledger à l'inscription ;
- `LedgerService` : écritures doubles dans une seule transaction PostgreSQL,
  avec `SELECT ... FOR UPDATE` et verrouillage par UUID croissant ;
- consultation du solde et du relevé de compte ;
- réconciliation cache / ledger.

## Checklist

- [ ] `docker compose up -d` puis `npm run prisma:migrate`
- [ ] `npm run start:dev` démarre sans erreur
- [ ] `POST /api/auth/otp/request` renvoie un `devCode`
- [ ] `POST /api/auth/register` renvoie deux jetons
- [ ] `GET /api/auth/me` sans jeton → 401 ; avec jeton → le profil
- [ ] `npm test` → 36 tests
- [ ] `npm run test:integration` → 46 tests
