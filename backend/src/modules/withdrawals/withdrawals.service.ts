import { Injectable } from '@nestjs/common';
import { Transaction, User } from '@prisma/client';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PinService } from '../auth/pin.service';
import { FeesService } from '../fees/fees.service';
import { LedgerService } from '../ledger/ledger.service';
import { LimitsService } from '../limits/limits.service';
import { ProviderRegistry } from '../payments/provider-registry.service';
import { SystemAccountsService } from '../payments/system-accounts.service';
import { UsersService } from '../users/users.service';
import { WalletsService } from '../wallets/wallets.service';
import { CreateWithdrawalDto } from './dto/withdrawal.dto';

/**
 * Retraits : faire sortir de l'argent du système.
 *
 * L'ORDRE EST L'INVERSE DU DÉPÔT, et pour une bonne raison.
 *
 * 1. À l'initiation, l'argent quitte IMMÉDIATEMENT le portefeuille du client
 *    pour un compte d'attente (SYSTEM_SUSPENSE). Sinon il pourrait le dépenser
 *    une seconde fois pendant que le partenaire prépare le versement — et nous
 *    paierions deux fois la même somme.
 *
 * 2. À la confirmation, l'argent quitte l'attente : la trésorerie diminue
 *    (le partenaire a payé) et les frais deviennent un produit.
 *
 * 3. En cas d'échec, l'argent revient du compte d'attente vers le client.
 *    Les écritures de retour s'AJOUTENT à celles du départ ; rien n'est effacé.
 *    L'historique montre l'argent parti puis revenu.
 *
 * SYSTEM_SUSPENSE doit donc toujours revenir à zéro. Un solde qui traîne
 * signale des retraits jamais dénoués — c'est une alerte d'exploitation.
 */
@Injectable()
export class WithdrawalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly fees: FeesService,
    private readonly limits: LimitsService,
    private readonly wallets: WalletsService,
    private readonly users: UsersService,
    private readonly pin: PinService,
    private readonly providers: ProviderRegistry,
    private readonly systemAccounts: SystemAccountsService,
    private readonly audit: AuditService,
  ) {}

  async quote(user: User, amount: Money) {
    const devis = await this.fees.quote('WITHDRAWAL', amount, user.role);

    return {
      // Le client reçoit `amount` et son compte est débité de `amount + frais`.
      amount: devis.amount.toJSON(),
      fee: devis.fee.toJSON(),
      total: devis.total.toJSON(),
      feeRule: devis.ruleName,
    };
  }

  async initiate(
    userId: string,
    dto: CreateWithdrawalDto,
    idempotencyKey: string,
    context: { ip?: string; userAgent?: string },
  ) {
    const user = await this.users.getByIdOrThrow(userId);
    const wallet = await this.wallets.getByUserId(user.id);
    const montant = Money.fromMajor(dto.amount);

    // Le code secret confirme l'intention : de l'argent SORT du compte.
    await this.verifyPin(user, dto.pin, context);

    const devis = await this.fees.quote('WITHDRAWAL', montant, user.role);
    const { provider, providerId } = await this.providers.requireActive(dto.provider ?? 'MOCK');

    const suspense = await this.systemAccounts.id('SYSTEM_SUSPENSE');

    // L'argent quitte le portefeuille MAINTENANT, pour le compte d'attente.
    // C'est ici que le contrôle de provision s'applique, sous verrou.
    const { transaction, replayed } = await this.ledger.post({
      type: 'WITHDRAWAL',
      initiatorId: user.id,
      amountMinor: devis.amount.minor,
      feeMinor: devis.fee.minor,
      currency: montant.currency,
      sourceWalletId: wallet.id,
      idempotencyKey,
      providerId,
      metadata: { account: dto.account },
      status: 'PROCESSING',
      legs: [
        {
          accountId: wallet.ledgerAccountId!,
          direction: 'DEBIT',
          amountMinor: devis.total.minor,
          description: 'Retrait demandé',
        },
        {
          accountId: suspense,
          direction: 'CREDIT',
          amountMinor: devis.total.minor,
          description: `Retrait en attente ${dto.account}`,
        },
      ],
      beforeWrite: (tx) =>
        this.limits.assertWithinLimits(user, 'WITHDRAWAL', montant, { client: tx }),
    });

    if (replayed) return this.toReceipt(transaction);

    const resultat = await provider.createWithdrawal({
      reference: transaction.reference,
      amountMinor: devis.amount.minor,
      currency: montant.currency,
      account: dto.account,
    });

    const misAJour = await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: { providerReference: resultat.providerReference },
    });

    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: 'WITHDRAWAL_INITIATED',
      entityType: 'Transaction',
      entityId: transaction.id,
      after: {
        reference: transaction.reference,
        amountMinor: devis.amount.minor.toString(),
        provider: provider.code,
      },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return { ...this.toReceipt(misAJour), instructions: resultat.instructions };
  }

  /** Le partenaire a payé le client : l'argent sort de l'attente. */
  async confirm(transaction: Transaction): Promise<Transaction> {
    const total = transaction.amountMinor + transaction.feeMinor;

    const legs = [
      {
        accountId: await this.systemAccounts.id('SYSTEM_SUSPENSE'),
        direction: 'DEBIT' as const,
        amountMinor: total,
        description: `Retrait payé ${transaction.reference}`,
      },
      {
        // SYSTEM_CASH est un ACTIF : il diminue au crédit. L'argent a
        // réellement quitté nos avoirs.
        accountId: await this.systemAccounts.id('SYSTEM_CASH'),
        direction: 'CREDIT' as const,
        amountMinor: transaction.amountMinor,
        description: 'Versement au client',
      },
    ];

    if (transaction.feeMinor > 0n) {
      // Les frais ne deviennent un produit qu'une fois le service rendu.
      legs.push({
        accountId: await this.systemAccounts.id('SYSTEM_REVENUE'),
        direction: 'CREDIT' as const,
        amountMinor: transaction.feeMinor,
        description: 'Frais de retrait',
      });
    }

    return this.ledger.settle(transaction.id, legs, { status: 'COMPLETED' });
  }

  /** Le partenaire n'a pas payé : l'argent revient au client, frais compris. */
  async reject(transaction: Transaction, reason: string): Promise<Transaction> {
    if (!transaction.sourceWalletId) {
      throw new BusinessError(
        ErrorCode.INTERNAL_ERROR,
        `Le retrait ${transaction.reference} n'a pas de portefeuille source.`,
        500,
      );
    }

    const wallet = await this.prisma.wallet.findUniqueOrThrow({
      where: { id: transaction.sourceWalletId },
    });

    const total = transaction.amountMinor + transaction.feeMinor;

    return this.ledger.settle(
      transaction.id,
      [
        {
          accountId: await this.systemAccounts.id('SYSTEM_SUSPENSE'),
          direction: 'DEBIT',
          amountMinor: total,
          description: `Retrait échoué ${transaction.reference}`,
        },
        {
          accountId: wallet.ledgerAccountId!,
          direction: 'CREDIT',
          amountMinor: total,
          // Les frais sont rendus aussi : le service n'a pas été rendu.
          description: 'Remboursement du retrait échoué',
        },
      ],
      { status: 'FAILED', failureReason: reason },
    );
  }

  async getForUser(userId: string, transactionId: string) {
    const wallet = await this.wallets.getByUserId(userId);

    const transaction = await this.prisma.transaction.findFirst({
      where: { id: transactionId, type: 'WITHDRAWAL', sourceWalletId: wallet.id },
    });

    if (!transaction) {
      throw new BusinessError(ErrorCode.NOT_FOUND, 'Retrait introuvable.', 404);
    }

    return this.toReceipt(transaction);
  }

  /**
   * Même contrôle, et surtout même compteur d'échecs que la connexion.
   *
   * Sans cela, cette route deviendrait un moyen de tester des codes secrets
   * sans jamais déclencher le blocage progressif.
   */
  private async verifyPin(
    user: User,
    pin: string,
    context: { ip?: string; userAgent?: string },
  ): Promise<void> {
    if (user.blockedUntil && user.blockedUntil.getTime() > Date.now()) {
      const minutes = this.pin.remainingLockMinutes(user.blockedUntil);
      throw new BusinessError(
        ErrorCode.ACCOUNT_BLOCKED,
        `Trop de tentatives. Réessayez dans ${minutes} minute(s).`,
        423,
        { retryAfterMinutes: minutes },
      );
    }

    if (await this.pin.verify(user.pinHash, pin)) {
      if (user.failedPinAttempts > 0) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { failedPinAttempts: 0, blockedUntil: null },
        });
      }
      return;
    }

    const state = this.pin.nextLockState(user.failedPinAttempts);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedPinAttempts: state.failedAttempts, blockedUntil: state.blockedUntil },
    });

    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: state.blockedUntil ? 'AUTH_ACCOUNT_LOCKED' : 'AUTH_PIN_FAILED',
      entityType: 'User',
      entityId: user.id,
      reason: `Confirmation de retrait, tentative ${state.failedAttempts}`,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    throw new BusinessError(ErrorCode.INVALID_CREDENTIALS, 'Code secret incorrect.', 401);
  }

  private toReceipt(transaction: Transaction) {
    return {
      id: transaction.id,
      reference: transaction.reference,
      status: transaction.status,
      amount: Money.fromMinor(transaction.amountMinor, transaction.currency).toJSON(),
      fee: Money.fromMinor(transaction.feeMinor, transaction.currency).toJSON(),
      total: Money.fromMinor(
        transaction.amountMinor + transaction.feeMinor,
        transaction.currency,
      ).toJSON(),
      providerReference: transaction.providerReference,
      failureReason: transaction.failureReason,
      date: transaction.completedAt ?? transaction.createdAt,
    };
  }
}
