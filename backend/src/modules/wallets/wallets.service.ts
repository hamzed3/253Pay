import { Injectable } from '@nestjs/common';
import { LedgerEntry, Prisma, Wallet } from '@prisma/client';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { PrismaService } from '../../database/prisma.service';
import { LedgerService } from '../ledger/ledger.service';

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Crée le portefeuille d'un client, avec son compte de ledger.
   *
   * `client` est passé en paramètre pour pouvoir participer à une transaction
   * déjà ouverte : à l'inscription, l'utilisateur et son portefeuille sont
   * créés ensemble ou pas du tout. Un client sans portefeuille serait un compte
   * inutilisable, à réparer à la main.
   *
   * Le compte de ledger est de type LIABILITY : cet argent ne nous appartient
   * pas, nous le devons au client.
   */
  async createForUser(
    userId: string,
    options: { currency?: string; client?: Prisma.TransactionClient } = {},
  ): Promise<Wallet> {
    const currency = options.currency ?? 'DJF';
    const db = options.client ?? this.prisma;

    const account = await db.ledgerAccount.create({
      data: {
        // Le code reste lisible dans un export comptable, sans jointure.
        code: `WALLET_${userId}`,
        name: `Portefeuille ${userId}`,
        ownerType: 'USER',
        ownerId: userId,
        type: 'LIABILITY',
        currency,
      },
    });

    return db.wallet.create({
      data: { userId, currency, ledgerAccountId: account.id },
    });
  }

  async getByUserId(userId: string, currency = 'DJF'): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId_currency: { userId, currency } },
    });

    if (!wallet) {
      throw new BusinessError(
        ErrorCode.WALLET_NOT_FOUND,
        'Aucun portefeuille pour ce compte.',
        404,
      );
    }

    return wallet;
  }

  /**
   * Solde du portefeuille.
   *
   * Renvoie le solde du LEDGER, pas le cache : c'est le ledger qui fait foi.
   * Le cache sert aux écrans qui doivent répondre vite ; un solde affiché à un
   * client, lui, doit être exact.
   */
  async getBalance(userId: string, currency = 'DJF') {
    const wallet = await this.getByUserId(userId, currency);
    const reconciliation = await this.ledger.reconcile(wallet.id);

    return {
      walletId: wallet.id,
      status: wallet.status,
      balance: Money.fromMinor(reconciliation.ledgerMinor, wallet.currency).toJSON(),
      reserved: Money.fromMinor(wallet.reservedMinor, wallet.currency).toJSON(),
      // Un écart signalé plutôt que masqué : le client voit le bon montant,
      // et l'exploitation sait qu'il y a un incident à instruire.
      consistent: reconciliation.consistent,
      updatedAt: wallet.updatedAt,
    };
  }

  async getStatement(
    userId: string,
    options: { limit: number; cursor?: string },
    currency = 'DJF',
  ) {
    const wallet = await this.getByUserId(userId, currency);

    if (!wallet.ledgerAccountId) {
      throw new BusinessError(
        ErrorCode.INTERNAL_ERROR,
        "Ce portefeuille n'a pas de compte de ledger.",
        500,
      );
    }

    const { entries, nextCursor } = await this.ledger.statement(wallet.ledgerAccountId, options);

    return {
      walletId: wallet.id,
      entries: entries.map((entry) => this.toStatementLine(entry, wallet.currency)),
      nextCursor,
    };
  }

  /**
   * Une ligne de relevé, telle que l'affichera le mobile.
   *
   * `direction` est traduite en `sens` : « sortie » ou « entrée ». Un client ne
   * sait pas ce qu'est un débit — et pour un portefeuille (une dette), le débit
   * correspond justement à une SORTIE d'argent, ce qui est contre-intuitif si
   * on l'affiche tel quel.
   *
   * Les montants passent par Money : un `bigint` renvoyé brut ferait échouer la
   * sérialisation JSON avec « Do not know how to serialize a BigInt ».
   */
  private toStatementLine(
    entry: LedgerEntry & {
      transaction: { reference: string; type: string; status: string; completedAt: Date | null };
    },
    currency: string,
  ) {
    return {
      id: entry.id,
      sens: entry.direction === 'DEBIT' ? 'sortie' : 'entree',
      amount: Money.fromMinor(entry.amountMinor, currency).toJSON(),
      balanceAfter: Money.fromMinor(entry.balanceAfterMinor, currency).toJSON(),
      description: entry.description,
      reference: entry.transaction.reference,
      type: entry.transaction.type,
      status: entry.transaction.status,
      date: entry.createdAt,
    };
  }
}
