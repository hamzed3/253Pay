import { Injectable } from '@nestjs/common';
import { Prisma, TransactionType, User } from '@prisma/client';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { PrismaService } from '../../database/prisma.service';
import { periodLabel, periodStart } from './limits.rules';

export interface LimitUsage {
  period: string;
  maxAmount: ReturnType<Money['toJSON']>;
  usedAmount: ReturnType<Money['toJSON']>;
  remainingAmount: ReturnType<Money['toJSON']>;
  maxCount: number | null;
  usedCount: number;
}

/**
 * Plafonds de transaction par niveau KYC.
 *
 * C'est ici que se joue une partie de la conformité anti-blanchiment : un
 * compte non vérifié ne doit pas pouvoir déplacer de gros montants. Le principe
 * ne changera pas ; les valeurs, elles, viennent de la base et devront être
 * alignées sur les textes de la Banque Centrale de Djibouti.
 *
 * Seules les opérations SORTANTES sont comptées. Recevoir de l'argent ne
 * consomme pas le plafond de celui qui reçoit — sinon un client pourrait
 * bloquer le compte d'un autre en lui envoyant de petites sommes.
 */
@Injectable()
export class LimitsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Vérifie qu'une opération tient dans les plafonds. Lève sinon.
   *
   * Appelée AVANT l'écriture comptable. Ce n'est pas un contrôle de solde —
   * celui-là se fait sous verrou dans le ledger — mais un contrôle
   * réglementaire, qui doit pouvoir être expliqué à un client.
   */
  async assertWithinLimits(
    user: Pick<User, 'id' | 'kycLevel'>,
    type: TransactionType,
    amount: Money,
    options: { client?: Prisma.TransactionClient; now?: Date } = {},
  ): Promise<void> {
    const now = options.now ?? new Date();

    // Le contrôle DOIT pouvoir s'exécuter dans la transaction du ledger, sous
    // le verrou des comptes. Sinon, deux transferts simultanés le passent tous
    // les deux et dépassent ensemble le plafond — c'est exactement le
    // fractionnement que la réglementation anti-blanchiment vise à empêcher.
    const db = options.client ?? this.prisma;

    const limits = await db.transactionLimit.findMany({
      where: {
        scope: 'USER',
        kycLevel: user.kycLevel,
        active: true,
        currency: amount.currency,
        OR: [{ transactionType: null }, { transactionType: type }],
      },
    });

    for (const limit of limits) {
      const debut = periodStart(limit.period, now);

      if (debut === null) {
        // Plafond par opération : la comparaison est immédiate.
        if (amount.minor > limit.maxAmountMinor) {
          throw this.exceeded(limit.period, limit.maxAmountMinor, amount.currency, {
            kycLevel: user.kycLevel,
          });
        }
        continue;
      }

      const usage = await this.usageSince(user.id, debut, amount.currency, db);

      if (usage.amountMinor + amount.minor > limit.maxAmountMinor) {
        throw this.exceeded(limit.period, limit.maxAmountMinor, amount.currency, {
          kycLevel: user.kycLevel,
          usedMinor: usage.amountMinor.toString(),
        });
      }

      if (limit.maxCount !== null && usage.count + 1 > limit.maxCount) {
        throw new BusinessError(
          ErrorCode.LIMIT_EXCEEDED,
          `Vous avez atteint le nombre maximal d'opérations ${periodLabel(limit.period)} (${limit.maxCount}).`,
          409,
          { period: limit.period, maxCount: limit.maxCount, usedCount: usage.count },
        );
      }
    }
  }

  /** Ce que le client a déjà consommé, pour affichage dans l'application. */
  async currentUsage(
    user: Pick<User, 'id' | 'kycLevel'>,
    currency = 'DJF',
    now: Date = new Date(),
  ): Promise<LimitUsage[]> {
    const limits = await this.prisma.transactionLimit.findMany({
      where: { scope: 'USER', kycLevel: user.kycLevel, active: true, currency },
      orderBy: { period: 'asc' },
    });

    const resultats: LimitUsage[] = [];

    for (const limit of limits) {
      const debut = periodStart(limit.period, now);
      const usage = debut
        ? await this.usageSince(user.id, debut, currency)
        : { amountMinor: 0n, count: 0 };

      const restant = limit.maxAmountMinor - usage.amountMinor;

      resultats.push({
        period: limit.period,
        maxAmount: Money.fromMinor(limit.maxAmountMinor, currency).toJSON(),
        usedAmount: Money.fromMinor(usage.amountMinor, currency).toJSON(),
        remainingAmount: Money.fromMinor(restant > 0n ? restant : 0n, currency).toJSON(),
        maxCount: limit.maxCount,
        usedCount: usage.count,
      });
    }

    return resultats;
  }

  /**
   * Somme des opérations sortantes du client depuis une date.
   *
   * `sourceWalletId` non nul identifie une sortie d'argent. Les transactions
   * échouées ou annulées ne comptent pas : seul ce qui est réellement parti
   * consomme un plafond.
   */
  private async usageSince(
    userId: string,
    since: Date,
    currency: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<{ amountMinor: bigint; count: number }> {
    const [row] = await db.$queryRaw<{ total: bigint; nombre: bigint }[]>`
      SELECT
        COALESCE(SUM(t."amount_minor"), 0)::bigint AS "total",
        COUNT(*)::bigint AS "nombre"
      FROM "transactions" t
      JOIN "wallets" w ON w."id" = t."source_wallet_id"
      WHERE w."user_id" = ${userId}::uuid
        AND t."currency" = ${currency}
        AND t."status" IN ('PENDING', 'PROCESSING', 'COMPLETED')
        AND t."created_at" >= ${since}
    `;

    return { amountMinor: BigInt(row.total), count: Number(row.nombre) };
  }

  private exceeded(
    period: string,
    maxMinor: bigint,
    currency: string,
    details: Record<string, unknown>,
  ): BusinessError {
    const plafond = Money.fromMinor(maxMinor, currency);

    return new BusinessError(
      ErrorCode.LIMIT_EXCEEDED,
      `Plafond ${periodLabel(period as never)} dépassé : ${plafond.format()} maximum. Vérifiez votre identité pour l'augmenter.`,
      409,
      { period, maxAmount: plafond.toJSON(), ...details },
    );
  }
}
