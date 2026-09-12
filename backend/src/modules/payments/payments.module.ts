import { Global, Module } from '@nestjs/common';
import { ProviderRegistry } from './provider-registry.service';
import { SystemAccountsService } from './system-accounts.service';
import { MockPaymentProvider } from './providers/mock-payment.provider';
import { PAYMENT_PROVIDERS, PaymentProvider } from './providers/payment-provider.interface';

/**
 * Le seul endroit qui connaît les partenaires de paiement.
 *
 * Pour en ajouter un le jour où un accord est signé : écrire une classe
 * implémentant `PaymentProvider`, l'ajouter à la liste ci-dessous, et insérer
 * sa ligne dans `payment_providers`. Aucun autre fichier ne change.
 */
@Global()
@Module({
  providers: [
    MockPaymentProvider,
    {
      provide: PAYMENT_PROVIDERS,
      inject: [MockPaymentProvider],
      useFactory: (mock: MockPaymentProvider): PaymentProvider[] => [mock],
    },
    ProviderRegistry,
    SystemAccountsService,
  ],
  exports: [ProviderRegistry, SystemAccountsService, MockPaymentProvider],
})
export class PaymentsModule {}
