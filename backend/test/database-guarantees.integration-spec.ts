import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Money } from '../src/common/money/money';

/**
 * PHASE 2 — ce que la base garantit toute seule.
 *
 * Ces tests ne vérifient pas du code applicatif : ils vérifient que
 * PostgreSQL REFUSE les opérations interdites par les règles du projet.
 * C'est la différence entre une règle écrite dans un document et une règle
 * qu'on ne peut pas enfreindre, même par accident, même avec un accès direct
 * à la base.
 */
const prisma = new PrismaClient();

const fdj = (major: string | number): bigint => Money.fromMajor(major, 'DJF').minor;

/** Crée un utilisateur et son portefeuille, avec un compte de ledger dédié. */
async function createWallet(label: string) {
  const suffix = randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: {
      phone: `+2537${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      firstName: label,
      lastName: 'Test',
      // Valeur de test uniquement. Le vrai hachage Argon2id arrive en PHASE 3.
      pinHash: `test-hash-${suffix}`,
      status: 'ACTIVE',
    },
  });

  const account = await prisma.ledgerAccount.create({
    data: {
      code: `WALLET_${suffix}`,
      name: `Portefeuille ${label}`,
      ownerType: 'USER',
      ownerId: user.id,
      // Le portefeuille d'un client est une DETTE de 253Pay envers lui.
      type: 'LIABILITY',
    },
  });

  const wallet = await prisma.wallet.create({
    data: { userId: user.id, ledgerAccountId: account.id },
  });

  return { user, account, wallet };
}

/**
 * Écrit une paire débit/crédit équilibrée et renvoie les deux écritures.
 *
 * On ne peut pas écrire une écriture seule : le déclencheur d'équilibre la
 * rejette au COMMIT. C'est voulu — et c'est d'ailleurs ce que vérifie le test
 * « refuse au COMMIT une transaction déséquilibrée ».
 */
async function createBalancedPair(
  transactionId: string,
  debitAccountId: string,
  creditAccountId: string,
  amount: bigint,
) {
  return prisma.$transaction([
    prisma.ledgerEntry.create({
      data: {
        transactionId,
        accountId: debitAccountId,
        direction: 'DEBIT',
        amountMinor: amount,
        balanceAfterMinor: -amount,
      },
    }),
    prisma.ledgerEntry.create({
      data: {
        transactionId,
        accountId: creditAccountId,
        direction: 'CREDIT',
        amountMinor: amount,
        balanceAfterMinor: amount,
      },
    }),
  ]);
}

let reference = 0;
async function createTransaction(
  data: Partial<Parameters<typeof prisma.transaction.create>[0]['data']> = {},
) {
  const owner = await createWallet('Initiateur');
  return prisma.transaction.create({
    data: {
      reference: `TX-TEST-${(++reference).toString().padStart(6, '0')}`,
      type: 'TRANSFER',
      amountMinor: fdj(5000),
      initiatorId: owner.user.id,
      ...data,
    } as Parameters<typeof prisma.transaction.create>[0]['data'],
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Le ledger est immuable', () => {
  it('refuse de modifier une écriture', async () => {
    const source = await createWallet('Immuable');
    const destination = await createWallet('ImmuableB');
    const transaction = await createTransaction();

    const [entry] = await createBalancedPair(
      transaction.id,
      source.account.id,
      destination.account.id,
      fdj(1000),
    );

    await expect(
      prisma.ledgerEntry.update({
        where: { id: entry.id },
        data: { amountMinor: fdj(999999) },
      }),
    ).rejects.toThrow(/LEDGER_IMMUTABLE/);
  });

  it('refuse de supprimer une écriture', async () => {
    const source = await createWallet('Immuable2');
    const destination = await createWallet('Immuable2B');
    const transaction = await createTransaction();

    const [entry] = await createBalancedPair(
      transaction.id,
      source.account.id,
      destination.account.id,
      fdj(1000),
    );

    await expect(prisma.ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
      /LEDGER_IMMUTABLE/,
    );
  });
});

describe('Une transaction financière ne se réécrit pas', () => {
  it('refuse la suppression', async () => {
    const transaction = await createTransaction();

    await expect(prisma.transaction.delete({ where: { id: transaction.id } })).rejects.toThrow(
      /TRANSACTION_IMMUTABLE/,
    );
  });

  it('refuse de faire revenir une transaction COMPLETED en arrière', async () => {
    const transaction = await createTransaction({
      status: 'COMPLETED',
      completedAt: new Date(),
    });

    await expect(
      prisma.transaction.update({ where: { id: transaction.id }, data: { status: 'PENDING' } }),
    ).rejects.toThrow(/TRANSACTION_IMMUTABLE/);
  });

  it('refuse de modifier le montant d’une transaction COMPLETED', async () => {
    const transaction = await createTransaction({
      status: 'COMPLETED',
      completedAt: new Date(),
    });

    await expect(
      prisma.transaction.update({
        where: { id: transaction.id },
        data: { amountMinor: fdj(1) },
      }),
    ).rejects.toThrow(/TRANSACTION_IMMUTABLE/);
  });

  it('autorise le passage COMPLETED -> REVERSED, seule évolution permise', async () => {
    const transaction = await createTransaction({
      status: 'COMPLETED',
      completedAt: new Date(),
    });

    const reversed = await prisma.transaction.update({
      where: { id: transaction.id },
      data: { status: 'REVERSED' },
    });

    expect(reversed.status).toBe('REVERSED');
  });
});

describe('Le ledger doit être équilibré', () => {
  it('accepte une transaction dont les débits égalent les crédits', async () => {
    const source = await createWallet('Source');
    const destination = await createWallet('Destination');
    const revenue = await prisma.ledgerAccount.findUniqueOrThrow({
      where: { code: 'SYSTEM_REVENUE' },
    });
    const transaction = await createTransaction({ feeMinor: fdj(50) });

    // Transfert de 5 000 FDJ, 50 FDJ de frais : 5 050 au débit, 5 050 au crédit.
    await prisma.$transaction([
      prisma.ledgerEntry.create({
        data: {
          transactionId: transaction.id,
          accountId: source.account.id,
          direction: 'DEBIT',
          amountMinor: fdj(5050),
          balanceAfterMinor: fdj(-5050),
        },
      }),
      prisma.ledgerEntry.create({
        data: {
          transactionId: transaction.id,
          accountId: destination.account.id,
          direction: 'CREDIT',
          amountMinor: fdj(5000),
          balanceAfterMinor: fdj(5000),
        },
      }),
      prisma.ledgerEntry.create({
        data: {
          transactionId: transaction.id,
          accountId: revenue.id,
          direction: 'CREDIT',
          amountMinor: fdj(50),
          balanceAfterMinor: fdj(50),
        },
      }),
    ]);

    const entries = await prisma.ledgerEntry.findMany({
      where: { transactionId: transaction.id },
    });
    const debit = entries
      .filter((e) => e.direction === 'DEBIT')
      .reduce((sum, e) => sum + e.amountMinor, 0n);
    const credit = entries
      .filter((e) => e.direction === 'CREDIT')
      .reduce((sum, e) => sum + e.amountMinor, 0n);

    expect(debit).toBe(credit);
    expect(debit).toBe(fdj(5050));
  });

  it('refuse au COMMIT une transaction déséquilibrée', async () => {
    const source = await createWallet('Deséquilibre');
    const destination = await createWallet('Deséquilibre2');
    const transaction = await createTransaction();

    // 5 000 sortent, 4 000 arrivent : 1 000 FDJ se volatilisent.
    // C'est exactement le bug qu'un moteur de frais mal écrit produirait.
    await expect(
      prisma.$transaction([
        prisma.ledgerEntry.create({
          data: {
            transactionId: transaction.id,
            accountId: source.account.id,
            direction: 'DEBIT',
            amountMinor: fdj(5000),
            balanceAfterMinor: fdj(-5000),
          },
        }),
        prisma.ledgerEntry.create({
          data: {
            transactionId: transaction.id,
            accountId: destination.account.id,
            direction: 'CREDIT',
            amountMinor: fdj(4000),
            balanceAfterMinor: fdj(4000),
          },
        }),
      ]),
    ).rejects.toThrow(/LEDGER_UNBALANCED/);

    // Et rien n'a été écrit : c'est tout ou rien.
    const entries = await prisma.ledgerEntry.findMany({
      where: { transactionId: transaction.id },
    });
    expect(entries).toHaveLength(0);
  });
});

describe('Les montants restent sains', () => {
  it('refuse un solde de portefeuille négatif', async () => {
    const { wallet } = await createWallet('Negatif');

    await expect(
      prisma.wallet.update({
        where: { id: wallet.id },
        data: { availableMinor: fdj(-1) },
      }),
    ).rejects.toThrow(/wallets_available_not_negative/);
  });

  it('refuse une écriture de montant nul', async () => {
    const account = await createWallet('Zero');
    const transaction = await createTransaction();

    // Le sens est porté par `direction` : un montant doit être > 0.
    await expect(
      prisma.ledgerEntry.create({
        data: {
          transactionId: transaction.id,
          accountId: account.account.id,
          direction: 'DEBIT',
          amountMinor: 0n,
          balanceAfterMinor: 0n,
        },
      }),
    ).rejects.toThrow(/ledger_entries_amount_strictly_positive/);
  });

  it('refuse des frais négatifs', async () => {
    await expect(createTransaction({ feeMinor: fdj(-10) })).rejects.toThrow(
      /transactions_fee_not_negative/,
    );
  });
});

describe('Idempotence', () => {
  it('refuse deux transactions portant la même Idempotency-Key', async () => {
    const key = randomUUID();

    await createTransaction({ idempotencyKey: key });

    // Le scénario réel : le réseau coupe, l'utilisateur réappuie sur
    // « Envoyer ». Sans cette contrainte, l'argent partirait deux fois.
    await expect(createTransaction({ idempotencyKey: key })).rejects.toThrow(
      /idempotency_key|Unique constraint/i,
    );
  });

  it('autorise plusieurs transactions internes sans clé', async () => {
    // Sous PostgreSQL, plusieurs NULL restent distincts : les transactions
    // internes ne se gênent pas entre elles.
    await expect(createTransaction()).resolves.toBeDefined();
    await expect(createTransaction()).resolves.toBeDefined();
  });
});

describe('Cohérence métier', () => {
  it('refuse une annulation qui ne pointe vers rien', async () => {
    await expect(createTransaction({ type: 'REVERSAL' })).rejects.toThrow(
      /transactions_reversal_coherent/,
    );
  });

  it('refuse un virement d’un portefeuille vers lui-même', async () => {
    const { wallet } = await createWallet('Boucle');

    await expect(
      createTransaction({ sourceWalletId: wallet.id, destinationWalletId: wallet.id }),
    ).rejects.toThrow(/transactions_source_differs_from_destination/);
  });

  it('refuse une transaction COMPLETED sans date de fin', async () => {
    await expect(createTransaction({ status: 'COMPLETED' })).rejects.toThrow(
      /transactions_completed_at_coherent/,
    );
  });

  it('refuse deux plafonds « tous types » pour le même niveau KYC', async () => {
    await expect(
      prisma.transactionLimit.create({
        data: {
          scope: 'USER',
          kycLevel: 0,
          period: 'DAILY',
          maxAmountMinor: fdj(999_999),
        },
      }),
    ).rejects.toThrow(/transaction_limits_all_types_key|Unique constraint/i);
  });

  it('refuse un niveau KYC hors des valeurs prévues', async () => {
    await expect(
      prisma.user.create({
        data: {
          phone: `+2537${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
          firstName: 'Kyc',
          lastName: 'Invalide',
          pinHash: 'test-hash',
          kycLevel: 7,
        },
      }),
    ).rejects.toThrow(/users_kyc_level_range/);
  });
});
