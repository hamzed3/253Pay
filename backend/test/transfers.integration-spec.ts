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
 * PHASE 5 — les transferts, de bout en bout.
 *
 * Ce qui est vérifié ici n'est pas seulement « l'argent arrive » : c'est que
 * le client ne peut PAS décider des frais, ne peut PAS dépasser son plafond,
 * ne peut PAS envoyer deux fois en réappuyant, et ne peut PAS tester des codes
 * secrets sans déclencher le blocage.
 */
let app: INestApplication;
let prisma: PrismaClient;
let ledger: LedgerService;
let systemCashId: string;

const fdj = (major: number | string) => Money.fromMajor(major).minor;

let phoneCounter = 800000;
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
  systemCashId = (await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: 'SYSTEM_CASH' } }))
    .id;
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

async function createClient(pin = '7391'): Promise<Client> {
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
      pin,
      device: { deviceId: `dev-${randomUUID()}`, platform: 'ANDROID' },
    })
    .expect(201);

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

/** Approvisionne un portefeuille sans passer par une route (PHASE 6). */
async function fund(client: Client, montant: number) {
  await ledger.post({
    type: 'DEPOSIT',
    initiatorId: client.userId,
    amountMinor: fdj(montant),
    legs: [
      { accountId: systemCashId, direction: 'DEBIT', amountMinor: fdj(montant) },
      { accountId: client.accountId, direction: 'CREDIT', amountMinor: fdj(montant) },
    ],
  });
}

const balance = async (client: Client) =>
  Money.fromMinor(await ledger.balanceOf(client.accountId)).format();

function transfer(sender: Client, dto: object, key = randomUUID()) {
  return http()
    .post('/api/transfers')
    .set('Authorization', `Bearer ${sender.token}`)
    .set('Idempotency-Key', key)
    .send(dto);
}

describe('Confirmer le bénéficiaire', () => {
  it('renvoie une identité réduite, jamais le nom complet', async () => {
    const expediteur = await createClient();
    const destinataire = await createClient();

    const response = await http()
      .get(`/api/transfers/recipient?phone=${destinataire.phone}`)
      .set('Authorization', `Bearer ${expediteur.token}`)
      .expect(200);

    // « Hamze M. » : assez pour vérifier, pas assez pour constituer un annuaire.
    expect(response.body.displayName).toBe('Hamze M.');
    expect(JSON.stringify(response.body)).not.toContain('Moussa');
  });

  it('exige une authentification', async () => {
    await http().get('/api/transfers/recipient?phone=77123456').expect(401);
  });

  it('refuse un numéro sans compte', async () => {
    const expediteur = await createClient();
    const response = await http()
      .get('/api/transfers/recipient?phone=77000001')
      .set('Authorization', `Bearer ${expediteur.token}`)
      .expect(404);
    expect(response.body.error.code).toBe('RECIPIENT_NOT_FOUND');
  });
});

describe('Simulation avant envoi', () => {
  it('annonce le montant, les frais et le total', async () => {
    const expediteur = await createClient();
    const destinataire = await createClient();

    const response = await http()
      .post('/api/transfers/quote')
      .set('Authorization', `Bearer ${expediteur.token}`)
      .send({ recipientPhone: destinataire.phone, amount: '5000' })
      .expect(200);

    // 1 % de 5 000 FDJ = 50 FDJ. Le client débourse 5 050 FDJ.
    expect(response.body.amount.formatted).toBe('5 000 FDJ');
    expect(response.body.fee.formatted).toBe('50 FDJ');
    expect(response.body.total.formatted).toBe('5 050 FDJ');
    expect(response.body.feeRule).toBe('Transfert entre clients');
  });

  it('applique le plancher de frais sur un petit montant', async () => {
    const expediteur = await createClient();
    const destinataire = await createClient();

    // 1 % de 500 FDJ = 5 FDJ, relevé au plancher de 25 FDJ.
    const response = await http()
      .post('/api/transfers/quote')
      .set('Authorization', `Bearer ${expediteur.token}`)
      .send({ recipientPhone: destinataire.phone, amount: '500' })
      .expect(200);

    expect(response.body.fee.formatted).toBe('25 FDJ');
  });

  it('refuse de simuler un envoi à soi-même', async () => {
    const expediteur = await createClient();

    const response = await http()
      .post('/api/transfers/quote')
      .set('Authorization', `Bearer ${expediteur.token}`)
      .send({ recipientPhone: expediteur.phone, amount: '1000' })
      .expect(400);

    expect(response.body.error.code).toBe('SELF_TRANSFER_FORBIDDEN');
  });
});

describe('Exécution du transfert', () => {
  it('déplace l’argent et prélève les frais', async () => {
    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 20000);

    const response = await transfer(expediteur, {
      recipientPhone: destinataire.phone,
      pin: '7391',
      amount: '5000',
      note: 'Loyer de septembre',
    }).expect(201);

    expect(response.body.reference).toMatch(/^TX-\d{4}-\d{6}$/);
    expect(response.body.total.formatted).toBe('5 050 FDJ');
    expect(response.body.recipient.displayName).toBe('Hamze M.');

    // 20 000 - 5 050 = 14 950 pour le payeur ; 5 000 pour le bénéficiaire.
    expect(await balance(expediteur)).toBe('14 950 FDJ');
    expect(await balance(destinataire)).toBe('5 000 FDJ');
  });

  it('crédite SYSTEM_REVENUE des frais, au franc près', async () => {
    const revenue = await prisma.ledgerAccount.findUniqueOrThrow({
      where: { code: 'SYSTEM_REVENUE' },
    });
    const avant = await ledger.balanceOf(revenue.id);

    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 20000);
    await transfer(expediteur, {
      recipientPhone: destinataire.phone,
      pin: '7391',
      amount: '5000',
    }).expect(201);

    expect((await ledger.balanceOf(revenue.id)) - avant).toBe(fdj(50));
  });

  it('IGNORE les frais envoyés par le client', async () => {
    // Risque n°6 : montant manipulé côté mobile. La validation est en mode
    // forbidNonWhitelisted, donc un champ `fee` fait échouer la requête —
    // le client ne peut même pas essayer de négocier son tarif.
    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 20000);

    const response = await transfer(expediteur, {
      recipientPhone: destinataire.phone,
      pin: '7391',
      amount: '5000',
      fee: '0',
      total: '5000',
    }).expect(400);

    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(await balance(expediteur)).toBe('20 000 FDJ');
  });

  it('refuse un solde insuffisant', async () => {
    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 1000);

    const response = await transfer(expediteur, {
      recipientPhone: destinataire.phone,
      pin: '7391',
      amount: '2000',
    }).expect(409);

    expect(response.body.error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('refuse quand les frais font dépasser le solde', async () => {
    // Le piège : 5 000 FDJ en poche, envoi de 5 000 FDJ. Il manque les frais.
    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 5000);

    await transfer(expediteur, {
      recipientPhone: destinataire.phone,
      pin: '7391',
      amount: '5000',
    }).expect(409);

    expect(await balance(expediteur)).toBe('5 000 FDJ');
  });

  it('exige l’en-tête Idempotency-Key', async () => {
    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 10000);

    const response = await http()
      .post('/api/transfers')
      .set('Authorization', `Bearer ${expediteur.token}`)
      .send({ recipientPhone: destinataire.phone, pin: '7391', amount: '1000' })
      .expect(400);

    expect(response.body.error.message).toMatch(/Idempotency-Key/);
  });

  it('refuse un montant mal formé', async () => {
    const expediteur = await createClient();
    const destinataire = await createClient();

    await transfer(expediteur, {
      recipientPhone: destinataire.phone,
      pin: '7391',
      amount: '10.999',
    }).expect(400);
  });
});

describe('Confirmation par code secret', () => {
  it('refuse un code incorrect', async () => {
    const expediteur = await createClient('7391');
    const destinataire = await createClient();
    await fund(expediteur, 20000);

    const response = await transfer(expediteur, {
      recipientPhone: destinataire.phone,
      pin: '1111',
      amount: '1000',
    }).expect(401);

    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(await balance(expediteur)).toBe('20 000 FDJ');
  });

  it('alimente le MÊME compteur d’échecs que la connexion', async () => {
    // Sans cela, cette route serait un moyen de tester des codes secrets sans
    // jamais déclencher le blocage : il suffirait d'enchaîner les transferts.
    const expediteur = await createClient('7391');
    const destinataire = await createClient();
    await fund(expediteur, 20000);

    for (let i = 0; i < 3; i++) {
      await transfer(expediteur, {
        recipientPhone: destinataire.phone,
        pin: '1111',
        amount: '1000',
      }).expect(401);
    }

    // Le compte est bloqué, y compris pour se CONNECTER.
    const connexion = await http()
      .post('/api/auth/login')
      .send({
        phone: expediteur.phone,
        pin: '7391',
        device: { deviceId: 'peu-importe', platform: 'ANDROID' },
      })
      .expect(423);

    expect(connexion.body.error.code).toBe('ACCOUNT_BLOCKED');
  });
});

describe('Plafonds selon le niveau KYC', () => {
  it('refuse un montant au-dessus du plafond par opération', async () => {
    // Niveau KYC 0 : 5 000 FDJ maximum par opération.
    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 100000);

    const response = await transfer(expediteur, {
      recipientPhone: destinataire.phone,
      pin: '7391',
      amount: '6000',
    }).expect(409);

    expect(response.body.error.code).toBe('LIMIT_EXCEEDED');
    expect(response.body.error.message).toMatch(/Vérifiez votre identité/);
  });

  it('refuse au-delà du plafond journalier cumulé', async () => {
    // Niveau 0 : 10 000 FDJ par jour. Deux envois de 5 000 passent, le
    // troisième non.
    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 100000);

    const envoi = () =>
      transfer(expediteur, {
        recipientPhone: destinataire.phone,
        pin: '7391',
        amount: '5000',
      });

    await envoi().expect(201);
    await envoi().expect(201);

    const response = await envoi().expect(409);
    expect(response.body.error.code).toBe('LIMIT_EXCEEDED');
    expect(response.body.error.message).toMatch(/journalier/);
  });

  it('laisse passer un montant plus élevé après vérification d’identité', async () => {
    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 100000);

    await transfer(expediteur, {
      recipientPhone: destinataire.phone,
      pin: '7391',
      amount: '6000',
    }).expect(409);

    // Passage au niveau 1 : plafond porté à 100 000 FDJ par opération.
    await prisma.user.update({ where: { id: expediteur.userId }, data: { kycLevel: 1 } });

    await transfer(expediteur, {
      recipientPhone: destinataire.phone,
      pin: '7391',
      amount: '6000',
    }).expect(201);
  });

  it('affiche les plafonds et ce qui a été consommé', async () => {
    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 50000);
    await transfer(expediteur, {
      recipientPhone: destinataire.phone,
      pin: '7391',
      amount: '4000',
    }).expect(201);

    const response = await http()
      .get('/api/transfers/limits')
      .set('Authorization', `Bearer ${expediteur.token}`)
      .expect(200);

    const journalier = response.body.limits.find((l: { period: string }) => l.period === 'DAILY');
    expect(journalier.usedAmount.formatted).toBe('4 000 FDJ');
    expect(journalier.remainingAmount.formatted).toBe('6 000 FDJ');
    expect(journalier.usedCount).toBe(1);
  });

  it('tient même sur trois envois simultanés — pas de fractionnement', async () => {
    // Le contournement évident : découper un gros montant en petits envois
    // lancés EN MÊME TEMPS. Si le plafond est vérifié avant l'écriture, chacun
    // lit un cumul de zéro et passe. Trois envois de 5 000 FDJ franchissaient
    // ainsi un plafond journalier de 10 000, à chaque essai.
    //
    // Le contrôle s'exécute désormais dans la transaction du ledger, sous le
    // verrou du compte du payeur : les envois sont examinés l'un après l'autre.
    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 100000);

    const envoi = () =>
      transfer(expediteur, {
        recipientPhone: destinataire.phone,
        pin: '7391',
        amount: '5000',
      });

    const resultats = await Promise.all([envoi(), envoi(), envoi()]);
    const acceptes = resultats.filter((r) => r.status === 201).length;

    // Deux au maximum : 2 x 5 000 = 10 000, le plafond exact.
    expect(acceptes).toBe(2);
    expect(await balance(destinataire)).toBe('10 000 FDJ');
  });

  it('ne consomme PAS le plafond de celui qui reçoit', async () => {
    // Sinon, envoyer de petites sommes à quelqu'un suffirait à bloquer son
    // compte pour la journée.
    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 50000);

    await transfer(expediteur, {
      recipientPhone: destinataire.phone,
      pin: '7391',
      amount: '5000',
    }).expect(201);

    const response = await http()
      .get('/api/transfers/limits')
      .set('Authorization', `Bearer ${destinataire.token}`)
      .expect(200);

    const journalier = response.body.limits.find((l: { period: string }) => l.period === 'DAILY');
    expect(journalier.usedAmount.formatted).toBe('0 FDJ');
  });
});

describe('Idempotence', () => {
  it('n’envoie qu’une fois si le client réappuie', async () => {
    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 20000);
    const cle = randomUUID();

    const corps = { recipientPhone: destinataire.phone, pin: '7391', amount: '3000' };

    const premiere = await transfer(expediteur, corps, cle).expect(201);
    const seconde = await transfer(expediteur, corps, cle).expect(201);

    expect(premiere.body.replayed).toBe(false);
    expect(seconde.body.replayed).toBe(true);
    expect(seconde.body.reference).toBe(premiere.body.reference);

    // 20 000 - 3 030 : l'argent n'est parti qu'une fois.
    expect(await balance(expediteur)).toBe('16 970 FDJ');
  });

  it('tient si les deux requêtes partent en même temps', async () => {
    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 20000);
    const cle = randomUUID();
    const corps = { recipientPhone: destinataire.phone, pin: '7391', amount: '3000' };

    const [une, deux] = await Promise.all([
      transfer(expediteur, corps, cle),
      transfer(expediteur, corps, cle),
    ]);

    expect(une.status).toBe(201);
    expect(deux.status).toBe(201);
    expect(une.body.reference).toBe(deux.body.reference);
    expect(await balance(expediteur)).toBe('16 970 FDJ');
  });
});

describe('Historique', () => {
  it('montre les transferts entrants et sortants', async () => {
    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 20000);
    await transfer(expediteur, {
      recipientPhone: destinataire.phone,
      pin: '7391',
      amount: '2000',
    }).expect(201);

    const sortant = await http()
      .get('/api/transfers')
      .set('Authorization', `Bearer ${expediteur.token}`)
      .expect(200);
    const ligneSortante = sortant.body.transfers.find(
      (t: { type: string }) => t.type === 'TRANSFER',
    );
    expect(ligneSortante.sens).toBe('sortant');
    expect(ligneSortante.fee.formatted).toBe('25 FDJ');

    const entrant = await http()
      .get('/api/transfers')
      .set('Authorization', `Bearer ${destinataire.token}`)
      .expect(200);
    const ligneEntrante = entrant.body.transfers.find(
      (t: { type: string }) => t.type === 'TRANSFER',
    );
    expect(ligneEntrante.sens).toBe('entrant');
    // Les frais ne concernent pas le bénéficiaire.
    expect(ligneEntrante.fee).toBeNull();
  });
});

describe('Annulation', () => {
  it('crée une transaction inverse plutôt que de modifier l’originale', async () => {
    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 20000);

    const transfert = await transfer(expediteur, {
      recipientPhone: destinataire.phone,
      pin: '7391',
      amount: '3000',
    }).expect(201);

    const admin = await createClient();
    await prisma.user.update({ where: { id: admin.userId }, data: { role: 'ADMIN' } });

    const annulation = await http()
      .post(`/api/transfers/${transfert.body.id}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'Erreur de saisie signalée par le client' })
      .expect(200);

    expect(annulation.body.reversal.reference).toMatch(/^TX-\d{4}-\d{6}$/);

    // L'originale existe toujours, marquée REVERSED : l'historique reste vrai.
    const originale = await prisma.transaction.findUniqueOrThrow({
      where: { id: transfert.body.id },
    });
    expect(originale.status).toBe('REVERSED');
    expect(originale.amountMinor).toBe(fdj(3000));

    // Et l'argent est revenu, frais compris.
    expect(await balance(expediteur)).toBe('20 000 FDJ');
    expect(await balance(destinataire)).toBe('0 FDJ');
  });

  it('refuse l’annulation à un simple client', async () => {
    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 20000);

    const transfert = await transfer(expediteur, {
      recipientPhone: destinataire.phone,
      pin: '7391',
      amount: '2000',
    }).expect(201);

    const response = await http()
      .post(`/api/transfers/${transfert.body.id}/reverse`)
      .set('Authorization', `Bearer ${expediteur.token}`)
      .send({ reason: 'Je change d’avis' })
      .expect(403);

    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('refuse d’annuler deux fois', async () => {
    const expediteur = await createClient();
    const destinataire = await createClient();
    await fund(expediteur, 20000);

    const transfert = await transfer(expediteur, {
      recipientPhone: destinataire.phone,
      pin: '7391',
      amount: '2000',
    }).expect(201);

    const admin = await createClient();
    await prisma.user.update({ where: { id: admin.userId }, data: { role: 'ADMIN' } });

    const annuler = () =>
      http()
        .post(`/api/transfers/${transfert.body.id}/reverse`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ reason: 'Double annulation' });

    await annuler().expect(200);
    const seconde = await annuler().expect(409);
    expect(seconde.body.error.code).toBe('TRANSACTION_NOT_REVERSIBLE');
  });

  it('refuse d’annuler si le bénéficiaire a déjà dépensé l’argent', async () => {
    // On ne met pas un compte client en négatif pour réparer une erreur.
    const expediteur = await createClient();
    const destinataire = await createClient();
    const tiers = await createClient();
    await fund(expediteur, 20000);

    const transfert = await transfer(expediteur, {
      recipientPhone: destinataire.phone,
      pin: '7391',
      amount: '3000',
    }).expect(201);

    // Le bénéficiaire dépense presque tout.
    await transfer(destinataire, {
      recipientPhone: tiers.phone,
      pin: '7391',
      amount: '2900',
    }).expect(201);

    const admin = await createClient();
    await prisma.user.update({ where: { id: admin.userId }, data: { role: 'ADMIN' } });

    const response = await http()
      .post(`/api/transfers/${transfert.body.id}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'Trop tard' })
      .expect(409);

    expect(response.body.error.code).toBe('INSUFFICIENT_FUNDS');

    // L'originale reste COMPLETED : rien n'a été touché.
    const originale = await prisma.transaction.findUniqueOrThrow({
      where: { id: transfert.body.id },
    });
    expect(originale.status).toBe('COMPLETED');
  });
});

describe('Le grand livre reste équilibré', () => {
  it('somme des débits = somme des crédits, après tous ces transferts', async () => {
    const [totaux] = await prisma.$queryRaw<{ debit: bigint; credit: bigint }[]>`
      SELECT
        COALESCE(SUM("amount_minor") FILTER (WHERE "direction" = 'DEBIT'), 0)::bigint AS "debit",
        COALESCE(SUM("amount_minor") FILTER (WHERE "direction" = 'CREDIT'), 0)::bigint AS "credit"
      FROM "ledger_entries"
    `;
    expect(BigInt(totaux.debit)).toBe(BigInt(totaux.credit));
  });
});
