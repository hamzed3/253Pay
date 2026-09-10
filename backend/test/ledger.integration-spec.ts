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

/**
 * PHASE 4 — le moteur comptable, en conditions réelles.
 *
 * Ces tests ne vérifient pas seulement que l'argent bouge : ils vérifient
 * qu'il ne peut PAS bouger de travers, y compris quand deux opérations
 * arrivent exactement au même instant.
 */
let app: INestApplication;
let prisma: PrismaClient;
let ledger: LedgerService;
let systemCashId: string;
let systemRevenueId: string;

const fdj = (major: number | string) => Money.fromMajor(major).minor;
const format = (minor: bigint) => Money.fromMinor(minor).format();

let phoneCounter = 500000;
const nextPhone = () => `77${String(++phoneCounter).slice(-6)}`;

const http = () => request(app.getHttpServer());

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication();
  configureApp(app, app.get(ConfigService));
  await app.init();

  prisma = new PrismaClient();
  ledger = app.get(LedgerService);

  systemCashId = (await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: 'SYSTEM_CASH' } }))
    .id;
  systemRevenueId = (
    await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: 'SYSTEM_REVENUE' } })
  ).id;
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
});

/** Inscrit un client et renvoie son compte, son portefeuille et ses jetons. */
async function createClient(pin = '7391') {
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
      firstName: 'Client',
      lastName: 'Test',
      pin,
      device: { deviceId: `dev-${randomUUID()}`, platform: 'ANDROID' },
    })
    .expect(201);

  const wallet = await prisma.wallet.findUniqueOrThrow({
    where: { userId_currency: { userId: registered.body.user.id, currency: 'DJF' } },
  });

  return {
    userId: registered.body.user.id as string,
    accessToken: registered.body.accessToken as string,
    walletId: wallet.id,
    accountId: wallet.ledgerAccountId!,
  };
}

/**
 * Approvisionne un portefeuille.
 *
 * Un dépôt ne CRÉE pas d'argent : il déplace de la trésorerie vers la dette
 * envers le client. SYSTEM_CASH (actif) augmente au débit, le portefeuille
 * (dette) augmente au crédit.
 */
async function fund(accountId: string, montant: number, initiatorId: string) {
  return ledger.post({
    type: 'DEPOSIT',
    initiatorId,
    amountMinor: fdj(montant),
    legs: [
      { accountId: systemCashId, direction: 'DEBIT', amountMinor: fdj(montant) },
      { accountId, direction: 'CREDIT', amountMinor: fdj(montant), description: 'Dépôt' },
    ],
  });
}

describe('Portefeuille à l’inscription', () => {
  it('crée le portefeuille et son compte de ledger', async () => {
    const client = await createClient();

    const account = await prisma.ledgerAccount.findUniqueOrThrow({
      where: { id: client.accountId },
    });

    // Le portefeuille d'un client est une DETTE de 253Pay envers lui.
    expect(account.type).toBe('LIABILITY');
    expect(account.ownerType).toBe('USER');
    expect(account.ownerId).toBe(client.userId);
  });

  it('démarre à zéro', async () => {
    const client = await createClient();

    const response = await http()
      .get('/api/wallets/me')
      .set('Authorization', `Bearer ${client.accessToken}`)
      .expect(200);

    expect(response.body.balance.formatted).toBe('0 FDJ');
    expect(response.body.consistent).toBe(true);
  });

  it('refuse de montrer un solde sans authentification', async () => {
    await http().get('/api/wallets/me').expect(401);
  });
});

describe('Écriture comptable', () => {
  it('crédite un portefeuille et met le cache à jour', async () => {
    const client = await createClient();
    await fund(client.accountId, 10000, client.userId);

    // Le solde du ledger fait foi...
    expect(format(await ledger.balanceOf(client.accountId))).toBe('10 000 FDJ');

    // ...et le cache le suit exactement.
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: client.walletId } });
    expect(wallet.availableMinor).toBe(fdj(10000));

    const reconciliation = await ledger.reconcile(client.walletId);
    expect(reconciliation.consistent).toBe(true);
  });

  it('enregistre un transfert avec frais, équilibré au franc près', async () => {
    const payeur = await createClient();
    const beneficiaire = await createClient();
    await fund(payeur.accountId, 20000, payeur.userId);

    // 5 000 FDJ envoyés, 50 FDJ de frais : le payeur débourse 5 050.
    await ledger.post({
      type: 'TRANSFER',
      initiatorId: payeur.userId,
      amountMinor: fdj(5000),
      feeMinor: fdj(50),
      sourceWalletId: payeur.walletId,
      destinationWalletId: beneficiaire.walletId,
      legs: [
        { accountId: payeur.accountId, direction: 'DEBIT', amountMinor: fdj(5050) },
        { accountId: beneficiaire.accountId, direction: 'CREDIT', amountMinor: fdj(5000) },
        { accountId: systemRevenueId, direction: 'CREDIT', amountMinor: fdj(50) },
      ],
    });

    expect(format(await ledger.balanceOf(payeur.accountId))).toBe('14 950 FDJ');
    expect(format(await ledger.balanceOf(beneficiaire.accountId))).toBe('5 000 FDJ');
  });

  it('refuse un déséquilibre avant même de toucher la base', async () => {
    const client = await createClient();
    const avant = await prisma.transaction.count();

    await expect(
      ledger.post({
        type: 'TRANSFER',
        initiatorId: client.userId,
        amountMinor: fdj(100),
        legs: [
          { accountId: systemCashId, direction: 'DEBIT', amountMinor: fdj(100) },
          { accountId: client.accountId, direction: 'CREDIT', amountMinor: fdj(99) },
        ],
      }),
    ).rejects.toThrow(/déséquilibrées/);

    // Aucune transaction créée, aucun numéro de référence consommé.
    expect(await prisma.transaction.count()).toBe(avant);
  });

  it('refuse un solde insuffisant', async () => {
    const client = await createClient();
    await fund(client.accountId, 1000, client.userId);

    await expect(
      ledger.post({
        type: 'WITHDRAWAL',
        initiatorId: client.userId,
        amountMinor: fdj(2000),
        legs: [
          { accountId: client.accountId, direction: 'DEBIT', amountMinor: fdj(2000) },
          { accountId: systemCashId, direction: 'CREDIT', amountMinor: fdj(2000) },
        ],
      }),
    ).rejects.toThrow(/Solde insuffisant/);

    expect(format(await ledger.balanceOf(client.accountId))).toBe('1 000 FDJ');
  });

  it('refuse tout mouvement sur un portefeuille gelé', async () => {
    const client = await createClient();
    await fund(client.accountId, 5000, client.userId);
    await prisma.wallet.update({ where: { id: client.walletId }, data: { status: 'FROZEN' } });

    await expect(
      ledger.post({
        type: 'WITHDRAWAL',
        initiatorId: client.userId,
        amountMinor: fdj(100),
        legs: [
          { accountId: client.accountId, direction: 'DEBIT', amountMinor: fdj(100) },
          { accountId: systemCashId, direction: 'CREDIT', amountMinor: fdj(100) },
        ],
      }),
    ).rejects.toThrow(/gelé/);
  });
});

describe('Concurrence — la faille numéro un des wallets amateurs', () => {
  it('empêche la double dépense sur deux retraits simultanés', async () => {
    const client = await createClient();
    await fund(client.accountId, 10000, client.userId);

    // Deux retraits de 10 000 FDJ envoyés EN MÊME TEMPS sur un solde de 10 000.
    // Sans verrou, les deux liraient « 10 000 » et passeraient : le compte
    // tomberait à −10 000 et 10 000 FDJ seraient créés à partir de rien.
    const retrait = () =>
      ledger.post({
        type: 'WITHDRAWAL',
        initiatorId: client.userId,
        amountMinor: fdj(10000),
        legs: [
          { accountId: client.accountId, direction: 'DEBIT', amountMinor: fdj(10000) },
          { accountId: systemCashId, direction: 'CREDIT', amountMinor: fdj(10000) },
        ],
      });

    const resultats = await Promise.allSettled([retrait(), retrait()]);
    const reussites = resultats.filter((r) => r.status === 'fulfilled');
    const echecs = resultats.filter((r) => r.status === 'rejected');

    expect(reussites).toHaveLength(1);
    expect(echecs).toHaveLength(1);
    expect(String((echecs[0] as PromiseRejectedResult).reason)).toMatch(/Solde insuffisant/);

    // Le solde final est exactement zéro, jamais négatif.
    expect(await ledger.balanceOf(client.accountId)).toBe(0n);
    expect((await ledger.reconcile(client.walletId)).consistent).toBe(true);
  });

  it('encaisse dix opérations simultanées sans perdre un franc', async () => {
    const client = await createClient();
    await fund(client.accountId, 100000, client.userId);

    // Dix retraits de 1 000 FDJ lancés ensemble sur 100 000 FDJ.
    const retraits = Array.from({ length: 10 }, () =>
      ledger.post({
        type: 'WITHDRAWAL',
        initiatorId: client.userId,
        amountMinor: fdj(1000),
        legs: [
          { accountId: client.accountId, direction: 'DEBIT', amountMinor: fdj(1000) },
          { accountId: systemCashId, direction: 'CREDIT', amountMinor: fdj(1000) },
        ],
      }),
    );

    const resultats = await Promise.allSettled(retraits);
    expect(resultats.every((r) => r.status === 'fulfilled')).toBe(true);

    // 100 000 - (10 x 1 000) = 90 000, au franc près.
    expect(format(await ledger.balanceOf(client.accountId))).toBe('90 000 FDJ');
    expect((await ledger.reconcile(client.walletId)).consistent).toBe(true);
  });

  it('ne s’interbloque pas sur deux transferts croisés A→B et B→A', async () => {
    // Si chaque transfert verrouillait d'abord son propre compte, le premier
    // tiendrait A en attendant B, le second tiendrait B en attendant A :
    // interblocage, et PostgreSQL tuerait l'une des deux transactions.
    // Le verrouillage par UUID croissant rend ce scénario impossible.
    const a = await createClient();
    const b = await createClient();
    await fund(a.accountId, 10000, a.userId);
    await fund(b.accountId, 10000, b.userId);

    const transfert = (de: typeof a, vers: typeof b) =>
      ledger.post({
        type: 'TRANSFER',
        initiatorId: de.userId,
        amountMinor: fdj(3000),
        sourceWalletId: de.walletId,
        destinationWalletId: vers.walletId,
        legs: [
          { accountId: de.accountId, direction: 'DEBIT', amountMinor: fdj(3000) },
          { accountId: vers.accountId, direction: 'CREDIT', amountMinor: fdj(3000) },
        ],
      });

    const resultats = await Promise.allSettled([transfert(a, b), transfert(b, a)]);

    expect(resultats.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(format(await ledger.balanceOf(a.accountId))).toBe('10 000 FDJ');
    expect(format(await ledger.balanceOf(b.accountId))).toBe('10 000 FDJ');
  });
});

describe('Idempotence', () => {
  it('ne déplace l’argent qu’une fois, même si la requête est rejouée', async () => {
    const client = await createClient();
    await fund(client.accountId, 10000, client.userId);
    const cle = randomUUID();

    const operation = () =>
      ledger.post({
        type: 'WITHDRAWAL',
        initiatorId: client.userId,
        amountMinor: fdj(2000),
        idempotencyKey: cle,
        legs: [
          { accountId: client.accountId, direction: 'DEBIT', amountMinor: fdj(2000) },
          { accountId: systemCashId, direction: 'CREDIT', amountMinor: fdj(2000) },
        ],
      });

    // Le scénario réel : le réseau coupe, le client réappuie sur « Envoyer ».
    const premiere = await operation();
    const seconde = await operation();

    expect(premiere.replayed).toBe(false);
    expect(seconde.replayed).toBe(true);
    expect(seconde.transaction.id).toBe(premiere.transaction.id);

    // 2 000 FDJ retirés une seule fois.
    expect(format(await ledger.balanceOf(client.accountId))).toBe('8 000 FDJ');
  });

  it('tient même si les deux requêtes arrivent exactement en même temps', async () => {
    // Ici la vérification applicative ne suffit pas : les deux requêtes la
    // passent. C'est l'index UNIQUE de PostgreSQL qui tranche.
    const client = await createClient();
    await fund(client.accountId, 10000, client.userId);
    const cle = randomUUID();

    const operation = () =>
      ledger.post({
        type: 'WITHDRAWAL',
        initiatorId: client.userId,
        amountMinor: fdj(2000),
        idempotencyKey: cle,
        legs: [
          { accountId: client.accountId, direction: 'DEBIT', amountMinor: fdj(2000) },
          { accountId: systemCashId, direction: 'CREDIT', amountMinor: fdj(2000) },
        ],
      });

    const [une, deux] = await Promise.all([operation(), operation()]);

    expect(une.transaction.id).toBe(deux.transaction.id);
    expect(format(await ledger.balanceOf(client.accountId))).toBe('8 000 FDJ');

    const transactions = await prisma.transaction.findMany({ where: { idempotencyKey: cle } });
    expect(transactions).toHaveLength(1);
  });
});

describe('Relevé de compte', () => {
  it('affiche les mouvements du plus récent au plus ancien, avec le solde', async () => {
    const client = await createClient();
    await fund(client.accountId, 10000, client.userId);
    await fund(client.accountId, 5000, client.userId);

    const response = await http()
      .get('/api/wallets/me/statement')
      .set('Authorization', `Bearer ${client.accessToken}`)
      .expect(200);

    expect(response.body.entries).toHaveLength(2);
    expect(response.body.entries[0].balanceAfter.formatted).toBe('15 000 FDJ');
    expect(response.body.entries[1].balanceAfter.formatted).toBe('10 000 FDJ');

    // « entree » plutôt que « CREDIT » : un client ne sait pas ce qu'est un
    // crédit, et pour un portefeuille le débit correspond à une SORTIE.
    expect(response.body.entries[0].sens).toBe('entree');
    expect(response.body.entries[0].reference).toMatch(/^TX-\d{4}-\d{6}$/);
  });

  it('pagine par curseur', async () => {
    const client = await createClient();
    for (let i = 0; i < 5; i++) await fund(client.accountId, 1000, client.userId);

    const page1 = await http()
      .get('/api/wallets/me/statement?limit=2')
      .set('Authorization', `Bearer ${client.accessToken}`)
      .expect(200);

    expect(page1.body.entries).toHaveLength(2);
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await http()
      .get(`/api/wallets/me/statement?limit=2&cursor=${page1.body.nextCursor}`)
      .set('Authorization', `Bearer ${client.accessToken}`)
      .expect(200);

    expect(page2.body.entries).toHaveLength(2);
    // Aucune ligne en double entre les deux pages.
    const ids = [...page1.body.entries, ...page2.body.entries].map((e: { id: string }) => e.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('plafonne la taille demandée', async () => {
    const client = await createClient();
    await http()
      .get('/api/wallets/me/statement?limit=5000')
      .set('Authorization', `Bearer ${client.accessToken}`)
      .expect(400);
  });
});

describe('Réconciliation', () => {
  it('détecte un cache qui ment', async () => {
    const client = await createClient();
    await fund(client.accountId, 10000, client.userId);

    // On corrompt volontairement le cache, comme le ferait un bug.
    await prisma.wallet.update({
      where: { id: client.walletId },
      data: { availableMinor: fdj(999999) },
    });

    const reconciliation = await ledger.reconcile(client.walletId);
    expect(reconciliation.consistent).toBe(false);
    expect(reconciliation.ledgerMinor).toBe(fdj(10000));

    // Le client voit le bon solde : c'est le LEDGER qui fait foi, pas le cache.
    const response = await http()
      .get('/api/wallets/me')
      .set('Authorization', `Bearer ${client.accessToken}`)
      .expect(200);

    expect(response.body.balance.formatted).toBe('10 000 FDJ');
    expect(response.body.consistent).toBe(false);
  });

  it('réserve la réconciliation d’un portefeuille aux administrateurs', async () => {
    const client = await createClient();

    const refus = await http()
      .get(`/api/wallets/${client.walletId}/reconciliation`)
      .set('Authorization', `Bearer ${client.accessToken}`)
      .expect(403);
    expect(refus.body.error.code).toBe('FORBIDDEN');

    // Le même appel passe pour un administrateur.
    const admin = await createClient();
    await prisma.user.update({ where: { id: admin.userId }, data: { role: 'ADMIN' } });

    const ok = await http()
      .get(`/api/wallets/${client.walletId}/reconciliation`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(ok.body.consistent).toBe(true);
  });
});

describe('Le total du système reste à zéro', () => {
  it('un dépôt déplace de l’argent, il n’en crée pas', async () => {
    const avantCash = await ledger.balanceOf(systemCashId);
    const client = await createClient();
    await fund(client.accountId, 7000, client.userId);

    const apresCash = await ledger.balanceOf(systemCashId);
    const soldeClient = await ledger.balanceOf(client.accountId);

    // La trésorerie augmente exactement de ce que le client a reçu :
    // l'actif détenu compense la dette contractée.
    expect(apresCash - avantCash).toBe(soldeClient);
  });

  it('somme des débits = somme des crédits sur tout le grand livre', async () => {
    const [totaux] = await prisma.$queryRaw<{ debit: bigint; credit: bigint }[]>`
      SELECT
        COALESCE(SUM("amount_minor") FILTER (WHERE "direction" = 'DEBIT'), 0)::bigint AS "debit",
        COALESCE(SUM("amount_minor") FILTER (WHERE "direction" = 'CREDIT'), 0)::bigint AS "credit"
      FROM "ledger_entries"
    `;

    // Si cette égalité tombe un jour, c'est que de l'argent est apparu ou a
    // disparu quelque part.
    expect(BigInt(totaux.debit)).toBe(BigInt(totaux.credit));
  });
});
