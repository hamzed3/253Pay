import { Global, Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';

/**
 * Global : tout module qui déplace de l'argent (transferts, dépôts, retraits,
 * paiements marchands…) passera par ce service, et par lui seul.
 */
@Global()
@Module({
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
