import { Injectable } from '@nestjs/common';
import { TransactionType, UserRole } from '@prisma/client';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { PrismaService } from '../../database/prisma.service';
import { computeFee, selectRule } from './fees.rules';

export interface FeeQuote {
  amount: Money;
  fee: Money;
  /** Ce que le payeur débourse réellement : montant + frais. */
  total: Money;
  ruleName: string | null;
}

@Injectable()
export class FeesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Calcule les frais d'une opération.
   *
   * Ne prend PAS de montant de frais en paramètre : c'est tout l'intérêt.
   * L'appelant fournit le type d'opération et le montant, le service décide.
   */
  async quote(
    type: TransactionType,
    amount: Money,
    userRole: UserRole = 'USER',
  ): Promise<FeeQuote> {
    if (!amount.isPositive()) {
      throw new BusinessError(
        ErrorCode.VALIDATION_FAILED,
        'Le montant doit être strictement positif.',
      );
    }

    const rules = await this.prisma.feeRule.findMany({
      where: { transactionType: type, active: true, currency: amount.currency },
    });

    const rule = selectRule(rules, amount.minor, userRole);

    // Aucune règle : frais nuls, jamais une erreur. Une grille tarifaire
    // incomplète ne doit pas bloquer un paiement — mais l'absence de règle est
    // visible dans la réponse (`ruleName: null`) et donc repérable.
    const fee = rule ? computeFee(rule, amount) : Money.zero(amount.currency);

    return {
      amount,
      fee,
      total: amount.add(fee),
      ruleName: rule?.name ?? null,
    };
  }
}
