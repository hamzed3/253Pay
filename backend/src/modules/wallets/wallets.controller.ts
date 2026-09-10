import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Money } from '../../common/money/money';
import { LedgerService } from '../ledger/ledger.service';
import { StatementQueryDto } from './dto/wallet.dto';
import { WalletsService } from './wallets.service';

/**
 * Consultation du portefeuille. LECTURE SEULE.
 *
 * Aucune route ne déplace d'argent en PHASE 4 : les transferts sont la
 * PHASE 5, les dépôts et retraits la PHASE 6. Le moteur d'écriture existe déjà
 * (LedgerService) mais n'est appelé par aucun contrôleur — c'est volontaire.
 */
@ApiTags('wallets')
@ApiBearerAuth()
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly wallets: WalletsService,
    private readonly ledger: LedgerService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Mon solde' })
  balance(@CurrentUser() user: AuthenticatedUser) {
    return this.wallets.getBalance(user.id);
  }

  @Get('me/statement')
  @ApiOperation({ summary: 'Mon relevé de compte, du plus récent au plus ancien' })
  statement(@CurrentUser() user: AuthenticatedUser, @Query() query: StatementQueryDto) {
    return this.wallets.getStatement(user.id, { limit: query.limit, cursor: query.cursor });
  }

  /**
   * Réconciliation d'un portefeuille : cache contre ledger.
   *
   * Réservée aux administrateurs. Un écart est une information d'exploitation,
   * pas quelque chose à exposer à un client — et le portefeuille visé n'est pas
   * forcément le sien.
   */
  @Get(':walletId/reconciliation')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Comparer le cache et le ledger (administrateurs)' })
  async reconcile(@Param('walletId', ParseUUIDPipe) walletId: string) {
    const result = await this.ledger.reconcile(walletId);

    return {
      walletId: result.walletId,
      cached: Money.fromMinor(result.cachedMinor).toJSON(),
      ledger: Money.fromMinor(result.ledgerMinor).toJSON(),
      drift: Money.fromMinor(result.driftMinor).toJSON(),
      consistent: result.consistent,
    };
  }
}
