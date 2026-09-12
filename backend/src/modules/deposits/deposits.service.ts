import { Injectable } from '@nestjs/common';
import { Transaction, User } from '@prisma/client';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FeesService } from '../fees/fees.service';
import { LedgerService } from '../ledger/ledger.service';
import { LimitsService } from '../limits/limits.service';
import { ProviderRegistry } from '../payments/provider-registry.service';
import { SystemAccountsService } from '../payments/system-accounts.service';
import { UsersService } from '../users/users.service';
import { WalletsService } from '../wallets/wallets.service';
import { CreateDepositDto } from './dto/deposit.dto';

/**
 * Dépôts : faire entrer de l'argent dans le système.
 *
 * DEUX TEMPS, ET C'EST ESSENTIEL :
 *
 * 1. À l'initiation, RIEN n'est écrit au ledger. Le client a demandé à verser
 *    10 000 FDJ, mais tant que le partenaire n'a pas encaissé, cet argent
 *    n'existe pas chez nous. L'inscrire tout de suite reviendrait à écrire
 *    dans les comptes une somme que nous ne détenons pas — et un client
 *    pourrait dépenser de l'argent jamais versé.
 *
 * 2. À la confirmation (webhook), l'argent est enfin écrit :
 *    SYSTEM_CASH est débité (notre trésorerie augmente), le portefeuille du
 *    client est crédité (notre dette envers lui augmente).
 *
 * Un dépôt ne CRÉE pas d'argent : il déplace de la trésorerie vers une dette.
 */
@Injectable()
export class DepositsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly fees: FeesService,
    private readonly limits: LimitsService,
    private readonly wallets: WalletsService,
    private readonly users: UsersService,
    private readonly providers: ProviderRegistry,
    private readonly systemAccounts: SystemAccountsService,
    private readonly audit: AuditService,
  ) {}

  /** Ce que le dépôt coûtera au client, avant qu'il ne s'engage. */
  async quote(user: User, amount: Money) {
    const devis = await this.fees.quote('DEPOSIT', amount, user.role);

    // Le client remet `amount` ; son portefeuille est crédité de `amount − frais`.
    const credite = devis.amount.subtract(devis.fee);

    if (!credite.isPositive()) {
      throw new BusinessError(
        ErrorCode.VALIDATION_FAILED,
        'Montant trop faible : les frais absorberaient la totalité du dépôt.',
      );
    }

    return {
      amount: devis.amount.toJSON(),
      fee: devis.fee.toJSON(),
      credited: credite.toJSON(),
      feeRule: devis.ruleName,
    };
  }

  async initiate(
    userId: string,
    dto: CreateDepositDto,
    idempotencyKey: string,
    context: { ip?: string; userAgent?: string },
  ) {
    const user = await this.users.getByIdOrThrow(userId);
    const wallet = await this.wallets.getByUserId(user.id);
    const montant = Money.fromMajor(dto.amount);

    const devis = await this.fees.quote('DEPOSIT', montant, user.role);
    const credite = devis.amount.subtract(devis.fee);

    if (!credite.isPositive()) {
      throw new BusinessError(
        ErrorCode.VALIDATION_FAILED,
        'Montant trop faible : les frais absorberaient la totalité du dépôt.',
      );
    }

    const { provider, providerId } = await this.providers.requireActive(dto.provider ?? 'MOCK');

    // La transaction est créée AVANT d'appeler le partenaire : sa référence lui
    // est transmise, ce qui permet de rapprocher son webhook de notre ligne.
    // Si l'appel au partenaire échoue ensuite, la transaction reste PROCESSING
    // et sera close par la tâche de reprise — jamais silencieusement perdue.
    const { transaction, replayed } = await this.ledger.openPending({
      type: 'DEPOSIT',
      initiatorId: user.id,
      amountMinor: devis.amount.minor,
      feeMinor: devis.fee.minor,
      currency: montant.currency,
      destinationWalletId: wallet.id,
      idempotencyKey,
      providerId,
      metadata: { account: dto.account },

      // Plafond d'ENTRÉE. Un compte non vérifié qui encaisse sans limite est
      // une porte d'entrée pour du blanchiment, même si l'argent ne ressort
      // qu'au compte-gouttes.
      beforeWrite: (tx) => this.limits.assertWithinLimits(user, 'DEPOSIT', montant, { client: tx }),
    });

    if (replayed) return this.toReceipt(transaction);

    const resultat = await provider.createDeposit({
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
      action: 'DEPOSIT_INITIATED',
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

  /**
   * Confirme un dépôt encaissé par le partenaire.
   *
   * Appelée UNIQUEMENT par le module webhooks, après vérification de la
   * signature et du montant.
   */
  async confirm(transaction: Transaction): Promise<Transaction> {
    if (!transaction.destinationWalletId) {
      throw new BusinessError(
        ErrorCode.INTERNAL_ERROR,
        `Le dépôt ${transaction.reference} n'a pas de portefeuille de destination.`,
        500,
      );
    }

    const wallet = await this.prisma.wallet.findUniqueOrThrow({
      where: { id: transaction.destinationWalletId },
    });

    const credite = transaction.amountMinor - transaction.feeMinor;

    const legs = [
      {
        // SYSTEM_CASH est un ACTIF : il augmente au débit. Le partenaire
        // détient désormais cet argent pour notre compte.
        accountId: await this.systemAccounts.id('SYSTEM_CASH'),
        direction: 'DEBIT' as const,
        amountMinor: transaction.amountMinor,
        description: `Encaissement ${transaction.reference}`,
      },
      {
        accountId: wallet.ledgerAccountId!,
        direction: 'CREDIT' as const,
        amountMinor: credite,
        description: 'Dépôt',
      },
    ];

    if (transaction.feeMinor > 0n) {
      legs.push({
        accountId: await this.systemAccounts.id('SYSTEM_REVENUE'),
        direction: 'CREDIT' as const,
        amountMinor: transaction.feeMinor,
        description: 'Frais de dépôt',
      });
    }

    return this.ledger.settle(transaction.id, legs, { status: 'COMPLETED' });
  }

  /** Le partenaire n'a pas encaissé : rien n'avait été écrit, rien à défaire. */
  async reject(transaction: Transaction, reason: string): Promise<Transaction> {
    return this.ledger.failPending(transaction.id, reason);
  }

  async getForUser(userId: string, transactionId: string) {
    const wallet = await this.wallets.getByUserId(userId);

    const transaction = await this.prisma.transaction.findFirst({
      where: { id: transactionId, type: 'DEPOSIT', destinationWalletId: wallet.id },
    });

    if (!transaction) {
      throw new BusinessError(ErrorCode.NOT_FOUND, 'Dépôt introuvable.', 404);
    }

    return this.toReceipt(transaction);
  }

  private toReceipt(transaction: Transaction) {
    return {
      id: transaction.id,
      reference: transaction.reference,
      status: transaction.status,
      amount: Money.fromMinor(transaction.amountMinor, transaction.currency).toJSON(),
      fee: Money.fromMinor(transaction.feeMinor, transaction.currency).toJSON(),
      credited: Money.fromMinor(
        transaction.amountMinor - transaction.feeMinor,
        transaction.currency,
      ).toJSON(),
      providerReference: transaction.providerReference,
      date: transaction.completedAt ?? transaction.createdAt,
    };
  }
}
