import { Inject, Injectable } from '@nestjs/common';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../database/prisma.service';
import { PAYMENT_PROVIDERS, PaymentProvider } from './providers/payment-provider.interface';

/**
 * Annuaire des fournisseurs de paiement.
 *
 * Deux conditions pour qu'un fournisseur soit utilisable : son code doit être
 * implémenté dans le code, ET la ligne correspondante de `payment_providers`
 * doit être ACTIVE en base. Le second point permet de couper un partenaire
 * défaillant sans déploiement.
 */
@Injectable()
export class ProviderRegistry {
  private readonly parCode = new Map<string, PaymentProvider>();

  constructor(
    @Inject(PAYMENT_PROVIDERS) providers: PaymentProvider[],
    private readonly prisma: PrismaService,
  ) {
    for (const provider of providers) this.parCode.set(provider.code, provider);
  }

  /** Sans vérifier la base : utilisé pour valider la signature d'un webhook. */
  find(code: string): PaymentProvider | undefined {
    return this.parCode.get(code);
  }

  /** Avec vérification de l'état en base : utilisé avant toute opération. */
  async requireActive(code: string): Promise<{ provider: PaymentProvider; providerId: string }> {
    const provider = this.parCode.get(code);

    if (!provider) {
      throw new BusinessError(
        ErrorCode.PROVIDER_UNAVAILABLE,
        `Fournisseur inconnu : ${code}.`,
        404,
      );
    }

    const ligne = await this.prisma.paymentProvider.findUnique({ where: { code } });

    if (!ligne || ligne.status !== 'ACTIVE') {
      throw new BusinessError(
        ErrorCode.PROVIDER_UNAVAILABLE,
        `Le fournisseur ${code} est indisponible pour le moment.`,
        503,
      );
    }

    return { provider, providerId: ligne.id };
  }

  /** Le fournisseur à utiliser par défaut. Un seul existe aujourd'hui. */
  async defaultProvider() {
    return this.requireActive('MOCK');
  }
}
