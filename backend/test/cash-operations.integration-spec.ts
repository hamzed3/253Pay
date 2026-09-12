import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { Money } from '../src/common/money/money';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { MockPaymentProvider } from '../src/modules/payments/providers/mock-payment.provider';

/**
 * PHASE 6 — dépôts, retraits et webhooks.
 *
 * Le cœur de ces tests n'est pas « l'argent arrive » mais : l'argent n'arrive
 * QUE si le partenaire a confirmé, avec une signature valide, un montant
 * cohérent, et une seule fois.
 */
let app: INestApplication;
let prisma: PrismaClient;
let ledger: LedgerService;
let mock: MockPaymentProvider;
let systemCashId: string;
let suspenseId: string;

const fdj = (major: number | string) => Money.fromMajor(major).minor;
const format = (minor: bigint) => Money.fromMinor(minor).format();

let phoneCounter = 300000;
const nextPhone = () => `77${String(++phoneCounter).slice(-6)}`;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication({ rawBody: true });
  configureApp(app, app.get(ConfigService));
  await app.init();

  prisma = new PrismaClient();
  ledger = app.get(LedgerService);
  mock = app.get(MockPaymentProvider);

  systemCashId = (await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: 'SYSTEM_CASH' } }))
    .id;
  suspenseId = (
    await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: 'SYSTEM_SUSPENSE' } })
  ).id;
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
});

interface Client {
  userId: string;
  phone: string;
  token: string;
  walletId: string;
  accountId: string;
}

async function createClient(kycLevel = 1): Promise<Client> {
  const phone = nextPhone();
  const otp = await http()
    .post('/api/auth/otp/request')
    .send({ phone, purpose: 'REGISTRATION' })
    .expect(200);

  const registered = await http()
    .post('/api/auth/register')
    .send({
      phone,
      code: otp.body.devCode,
      firstName: 'Hamze',
      lastName: 'Moussa',
      pin: '7391',
      device: { deviceId: `dev-${randomUUID()}`, platform: 'ANDROID' },
    })
    .expect(201);

  // Niveau 1 par défaut : les plafonds du niveau 0 (5 000 FDJ) rendraient la
  // plupart de ces scénarios impossibles.
  await prisma.user.update({ where: { id: registered.body.user.id }, data: { kycLevel } });

  const wallet = await prisma.wallet.findUniqueOrThrow({
    where: { userId_currency: { userId: registered.body.user.id, currency: 'DJF' } },
  });

  return {
    userId: registered.body.user.id,
    phone,
    token: registered.body.accessToken,
    walletId: wallet.id,
    accountId: wallet.ledgerAccountId!,
  };
}

const balance = async (client: Client) => format(await ledger.balanceOf(client.accountId));

function deposit(client: Client, body: object, key = randomUUID()) {
  return http()
    .post('/api/deposits')
    .set('Authorization', `Bearer ${client.token}`)
    .set('Idempotency-Key', key)
    .send(body);
}

function withdraw(client: Client, body: object, key = randomUUID()) {
  return http()
    .post('/api/withdrawals')
    .set('Authorization', `Bearer ${client.token}`)
    .set('Idempotency-Key', key)
    .send(body);
}

/**
 * Envoie un webhook signé, comme le ferait le partenaire.
 *
 * Le corps est envoyé sous forme de CHAÎNE, pas d'objet ni de Buffer : c'est
 * la seule façon de garantir que les octets reçus par le serveur sont
 * exactement ceux qui ont été signés. Passer un objet laisserait supertest le
 * re-sérialiser, et la signature ne correspondrait plus — la même erreur
 * qu'un partenaire commettrait en signant l'objet plutôt que le corps brut.
 */
function sendWebhook(payload: object, options: { signature?: string } = {}) {
  const corps = JSON.stringify(payload);
  const signature = options.signature ?? mock.sign(Buffer.from(corps));

  return http()
    .post('/api/webhooks/MOCK')
    .set('Content-Type', 'application/json')
    .set('x-provider-signature', signature)
    .send(corps);
}

const evenement = (over: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  eventType: 'operation.updated',
  providerReference: 'inconnue',
  status: 'SUCCEEDED',
  amountMinor: '0',
  ...over,
});

describe('Dépôt', () => {
  it('n’écrit RIEN au ledger tant que le partenaire n’a pas confirmé', async () => {
    const client = await createClient();

    const response = await deposit(client, { amount: '10000', account: '77123456' }).expect(201);

    expect(response.body.status).toBe('PROCESSING');
    expect(response.body.providerReference).toMatch(/^MOCK-/);

    // Le point essentiel : l'argent n'existe pas encore.
    expect(await balance(client)).toBe('0 FDJ');
    const ecritures = await prisma.ledgerEntry.count({
      where: { transactionId: response.body.id },
    });
    expect(ecritures).toBe(0);
  });

  it('crédite le client quand le partenaire confirme', async () => {
    const client = await createClient();
    const avantCash = await ledger.balanceOf(systemCashId);

    const depot = await deposit(client, { amount: '10000', account: '77123456' }).expect(201);

    await sendWebhook(
      evenement({
        providerReference: depot.body.providerReference,
        amountMinor: String(fdj(10000)),
      }),
    ).expect(200);

    expect(await balance(client)).toBe('10 000 FDJ');

    // Un dépôt ne crée pas d'argent : la trésorerie augmente d'autant.
    expect((await ledger.balanceOf(systemCashId)) - avantCash).toBe(fdj(10000));

    const apres = await prisma.transaction.findUniqueOrThrow({ where: { id: depot.body.id } });
    expect(apres.status).toBe('COMPLETED');
  });

  it('ferme le dépôt sans rien créditer si le partenaire refuse', async () => {
    const client = await createClient();
    const depot = await deposit(client, { amount: '10000', account: '77123456' }).expect(201);

    await sendWebhook(
      evenement({
        providerReference: depot.body.providerReference,
        amountMinor: String(fdj(10000)),
        status: 'FAILED',
        failureReason: 'Fonds insuffisants chez le partenaire',
      }),
    ).expect(200);

    expect(await balance(client)).toBe('0 FDJ');
    const apres = await prisma.transaction.findUniqueOrThrow({ where: { id: depot.body.id } });
    expect(apres.status).toBe('FAILED');
    expect(apres.failureReason).toMatch(/Fonds insuffisants/);
  });

  it('annonce le montant crédité avant que le client ne s’engage', async () => {
    const client = await createClient();

    const response = await http()
      .post('/api/deposits/quote')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ amount: '10000' })
      .expect(200);

    // Le dépôt est gratuit dans la grille actuelle.
    expect(response.body.fee.formatted).toBe('0 FDJ');
    expect(response.body.credited.formatted).toBe('10 000 FDJ');
  });

  it('exige l’en-tête Idempotency-Key', async () => {
    const client = await createClient();
    await http()
      .post('/api/deposits')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ amount: '10000', account: '77123456' })
      .expect(400);
  });

  it('respecte le plafond d’ENTRÉE du niveau KYC', async () => {
    // Niveau 0 : 5 000 FDJ par opération. Un compte non vérifié qui encaisse
    // sans limite est une porte d'entrée pour du blanchiment.
    const client = await createClient(0);

    const response = await deposit(client, { amount: '6000', account: '77123456' }).expect(409);
    expect(response.body.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('ne consomme pas le plafond de SORTIE', async () => {
    const client = await createClient();
    const depot = await deposit(client, { amount: '10000', account: '77123456' }).expect(201);
    await sendWebhook(
      evenement({
        providerReference: depot.body.providerReference,
        amountMinor: String(fdj(10000)),
      }),
    ).expect(200);

    const limites = await http()
      .get('/api/transfers/limits')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);

    const journalier = limites.body.limits.find((l: { period: string }) => l.period === 'DAILY');
    expect(journalier.usedAmount.formatted).toBe('0 FDJ');
  });
});

describe('Retrait', () => {
  async function clientAvecSolde(montant: number): Promise<Client> {
    const client = await createClient();
    await ledger.post({
      type: 'DEPOSIT',
      initiatorId: client.userId,
      amountMinor: fdj(montant),
      legs: [
        { accountId: systemCashId, direction: 'DEBIT', amountMinor: fdj(montant) },
        { accountId: client.accountId, direction: 'CREDIT', amountMinor: fdj(montant) },
      ],
    });
    return client;
  }

  it('sort l’argent du portefeuille IMMÉDIATEMENT, vers le compte d’attente', async () => {
    // Sinon le client dépenserait deux fois la même somme pendant que le
    // partenaire prépare le versement.
    const client = await clientAvecSolde(50000);
    const avantSuspense = await ledger.balanceOf(suspenseId);

    const retrait = await withdraw(client, {
      amount: '10000',
      account: '77123456',
      pin: '7391',
    }).expect(201);

    // 10 000 + 150 de frais (1,5 %).
    expect(retrait.body.total.formatted).toBe('10 150 FDJ');
    expect(retrait.body.status).toBe('PROCESSING');
    expect(await balance(client)).toBe('39 850 FDJ');

    // L'argent est en attente, ni chez le client ni sorti.
    expect((await ledger.balanceOf(suspenseId)) - avantSuspense).toBe(fdj(10150));
  });

  it('vide le compte d’attente quand le partenaire a payé', async () => {
    const client = await clientAvecSolde(50000);
    const avantSuspense = await ledger.balanceOf(suspenseId);
    const avantCash = await ledger.balanceOf(systemCashId);

    const retrait = await withdraw(client, {
      amount: '10000',
      account: '77123456',
      pin: '7391',
    }).expect(201);

    await sendWebhook(
      evenement({
        providerReference: retrait.body.providerReference,
        amountMinor: String(fdj(10000)),
      }),
    ).expect(200);

    // SYSTEM_SUSPENSE revient à son niveau de départ : rien ne traîne.
    expect(await ledger.balanceOf(suspenseId)).toBe(avantSuspense);
    // La trésorerie diminue de ce qui a été versé.
    expect(avantCash - (await ledger.balanceOf(systemCashId))).toBe(fdj(10000));
    expect(await balance(client)).toBe('39 850 FDJ');
  });

  it('rend l’argent, frais compris, si le versement échoue', async () => {
    const client = await clientAvecSolde(50000);
    const avantSuspense = await ledger.balanceOf(suspenseId);

    const retrait = await withdraw(client, {
      amount: '10000',
      account: '77123456',
      pin: '7391',
    }).expect(201);

    await sendWebhook(
      evenement({
        providerReference: retrait.body.providerReference,
        amountMinor: String(fdj(10000)),
        status: 'FAILED',
        failureReason: 'Compte destinataire fermé',
      }),
    ).expect(200);

    // Les frais sont rendus aussi : le service n'a pas été rendu.
    expect(await balance(client)).toBe('50 000 FDJ');
    expect(await ledger.balanceOf(suspenseId)).toBe(avantSuspense);

    const apres = await prisma.transaction.findUniqueOrThrow({ where: { id: retrait.body.id } });
    expect(apres.status).toBe('FAILED');

    // Rien n'a été effacé : l'aller et le retour sont tous deux inscrits.
    const ecritures = await prisma.ledgerEntry.count({ where: { transactionId: retrait.body.id } });
    expect(ecritures).toBe(4);
  });

  it('refuse un retrait sans provision, frais compris', async () => {
    const client = await clientAvecSolde(10000);

    // 10 000 en poche, retrait de 10 000 : il manque les 150 FDJ de frais.
    const response = await withdraw(client, {
      amount: '10000',
      account: '77123456',
      pin: '7391',
    }).expect(409);

    expect(response.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await balance(client)).toBe('10 000 FDJ');
  });

  it('exige le code secret, et alimente le compteur d’échecs partagé', async () => {
    const client = await clientAvecSolde(50000);

    for (let i = 0; i < 3; i++) {
      await withdraw(client, { amount: '1000', account: '77123456', pin: '1111' }).expect(401);
    }

    const connexion = await http()
      .post('/api/auth/login')
      .send({ phone: client.phone, pin: '7391', device: { deviceId: 'x', platform: 'ANDROID' } })
      .expect(423);
    expect(connexion.body.error.code).toBe('ACCOUNT_BLOCKED');
  });

  it('empêche de retirer deux fois le même solde en simultané', async () => {
    const client = await clientAvecSolde(10150);

    const resultats = await Promise.all([
      withdraw(client, { amount: '10000', account: '77123456', pin: '7391' }),
      withdraw(client, { amount: '10000', account: '77123456', pin: '7391' }),
    ]);

    const acceptes = resultats.filter((r) => r.status === 201).length;
    expect(acceptes).toBe(1);
    expect(await balance(client)).toBe('0 FDJ');
  });
});

describe('Webhooks — la porte la plus exposée', () => {
  async function depotEnAttente() {
    const client = await createClient();
    const depot = await deposit(client, { amount: '10000', account: '77123456' }).expect(201);
    return { client, depot: depot.body };
  }

  it('refuse un message sans signature', async () => {
    const { client, depot } = await depotEnAttente();

    const response = await http()
      .post('/api/webhooks/MOCK')
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify(
          evenement({
            providerReference: depot.providerReference,
            amountMinor: String(fdj(10000)),
          }),
        ),
      )
      .expect(401);

    expect(response.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(await balance(client)).toBe('0 FDJ');
  });

  it('refuse une signature forgée', async () => {
    // Sans cette vérification, n'importe qui créditerait le compte de son choix.
    const { client, depot } = await depotEnAttente();

    await sendWebhook(
      evenement({ providerReference: depot.providerReference, amountMinor: String(fdj(10000)) }),
      { signature: 'a'.repeat(64) },
    ).expect(401);

    expect(await balance(client)).toBe('0 FDJ');
  });

  it('conserve la trace des messages rejetés', async () => {
    const { depot } = await depotEnAttente();
    const avant = await prisma.webhookEvent.count({ where: { signatureValid: false } });

    await sendWebhook(evenement({ providerReference: depot.providerReference }), {
      signature: 'b'.repeat(64),
    }).expect(401);

    // Un payload rejeté est la trace d'une tentative de fraude, pas un déchet.
    expect(await prisma.webhookEvent.count({ where: { signatureValid: false } })).toBe(avant + 1);
  });

  it('refuse un montant qui ne correspond pas à l’opération', async () => {
    // Même signé, un message annonçant un million pour un dépôt de 10 000
    // doit être refusé : un partenaire peut se tromper, une clé peut fuiter.
    const { client, depot } = await depotEnAttente();

    const response = await sendWebhook(
      evenement({
        providerReference: depot.providerReference,
        amountMinor: String(fdj(1000000)),
      }),
    ).expect(409);

    expect(response.body.error.code).toBe('AMOUNT_MISMATCH');
    expect(await balance(client)).toBe('0 FDJ');
  });

  it('ne crédite qu’une fois si le partenaire renvoie le même événement', async () => {
    // Les partenaires rejouent souvent leurs notifications.
    const { client, depot } = await depotEnAttente();
    const message = evenement({
      providerReference: depot.providerReference,
      amountMinor: String(fdj(10000)),
    });

    const premiere = await sendWebhook(message).expect(200);
    const seconde = await sendWebhook(message).expect(200);

    expect(premiere.body.status).toBe('settled');
    expect(seconde.body.status).toBe('already_processed');
    expect(await balance(client)).toBe('10 000 FDJ');
  });

  it('tient si deux notifications identiques arrivent en même temps', async () => {
    const { client, depot } = await depotEnAttente();
    const message = evenement({
      providerReference: depot.providerReference,
      amountMinor: String(fdj(10000)),
    });

    const [une, deux] = await Promise.all([sendWebhook(message), sendWebhook(message)]);

    // Les DEUX doivent répondre 200, quelle que soit celle qui gagne la course.
    // Un doublon n'est pas une erreur : renvoyer un 409 — ou pire, une 500 —
    // ferait rejouer le partenaire indéfiniment pour rien.
    expect(une.status).toBe(200);
    expect(deux.status).toBe(200);

    // Quoi qu'il arrive, le client n'est crédité qu'une fois.
    expect(await balance(client)).toBe('10 000 FDJ');
    const ecritures = await prisma.ledgerEntry.count({ where: { transactionId: depot.id } });
    expect(ecritures).toBe(2);
  });

  it('ignore une notification sur une opération déjà dénouée', async () => {
    const { depot } = await depotEnAttente();
    await sendWebhook(
      evenement({ providerReference: depot.providerReference, amountMinor: String(fdj(10000)) }),
    ).expect(200);

    // Nouvel identifiant d'événement, même opération.
    const seconde = await sendWebhook(
      evenement({
        providerReference: depot.providerReference,
        amountMinor: String(fdj(10000)),
        status: 'FAILED',
      }),
    ).expect(200);

    expect(seconde.body.status).toBe('already_settled');
  });

  it('refuse une référence inconnue', async () => {
    await sendWebhook(evenement({ providerReference: 'MOCK-JAMAIS-VUE' })).expect(404);
  });

  it('refuse un fournisseur inconnu', async () => {
    await http()
      .post('/api/webhooks/DMONEY')
      .set('Content-Type', 'application/json')
      .send('{}')
      .expect(404);
  });
});

describe('Le grand livre reste équilibré', () => {
  it('somme des débits = somme des crédits', async () => {
    const [totaux] = await prisma.$queryRaw<{ debit: bigint; credit: bigint }[]>`
      SELECT
        COALESCE(SUM("amount_minor") FILTER (WHERE "direction" = 'DEBIT'), 0)::bigint AS "debit",
        COALESCE(SUM("amount_minor") FILTER (WHERE "direction" = 'CREDIT'), 0)::bigint AS "credit"
      FROM "ledger_entries"
    `;
    expect(BigInt(totaux.debit)).toBe(BigInt(totaux.credit));
  });
});
