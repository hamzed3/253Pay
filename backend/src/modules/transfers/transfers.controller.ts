import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { StatementQueryDto } from '../wallets/dto/wallet.dto';
import { UsersService } from '../users/users.service';
import { LimitsService } from '../limits/limits.service';
import { CreateTransferDto, QuoteTransferDto, ReverseTransferDto } from './dto/transfer.dto';
import { TransfersService } from './transfers.service';

@ApiTags('transfers')
@ApiBearerAuth()
@Controller('transfers')
export class TransfersController {
  constructor(
    private readonly transfers: TransfersService,
    private readonly users: UsersService,
    private readonly limits: LimitsService,
  ) {}

  /**
   * Confirmer un bénéficiaire avant d'envoyer.
   *
   * Limite de débit stricte : cette route dit si un numéro possède un compte,
   * ce qui en fait un moyen d'énumération. 20 appels par minute suffisent
   * largement à un usage normal, et rendent le balayage inutilisable.
   */
  @Get('recipient')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Vérifier à qui appartient un numéro (identité réduite)' })
  lookup(@Query('phone') phone: string) {
    return this.transfers.lookupRecipient(phone);
  }

  @Post('quote')
  @HttpCode(200)
  @ApiOperation({ summary: 'Simuler un transfert : montant, frais et total' })
  async quote(@CurrentUser() current: AuthenticatedUser, @Body() dto: QuoteTransferDto) {
    const sender = await this.users.getByIdOrThrow(current.id);
    return this.transfers.quote(sender, dto);
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Généré AVANT le premier envoi et réutilisé à chaque nouvelle tentative',
  })
  @ApiOperation({ summary: 'Envoyer de l’argent à un autre client' })
  execute(
    @CurrentUser() current: AuthenticatedUser,
    @Body() dto: CreateTransferDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() request: Request,
  ) {
    return this.transfers.execute(current.id, dto, idempotencyKey, this.context(request));
  }

  @Get()
  @ApiOperation({ summary: 'Mes transferts, entrants et sortants' })
  history(@CurrentUser() current: AuthenticatedUser, @Query() query: StatementQueryDto) {
    return this.transfers.history(current.id, { limit: query.limit, cursor: query.cursor });
  }

  @Get('limits')
  @ApiOperation({ summary: 'Mes plafonds et ce que j’ai déjà consommé' })
  async limitsUsage(@CurrentUser() current: AuthenticatedUser) {
    const user = await this.users.getByIdOrThrow(current.id);
    return { kycLevel: user.kycLevel, limits: await this.limits.currentUsage(user) };
  }

  /**
   * Annulation, réservée aux administrateurs.
   *
   * Un client ne peut pas défaire un paiement qu'il a validé : sinon aucun
   * marchand ne serait jamais payé en confiance.
   */
  @Post(':id/reverse')
  @HttpCode(200)
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Annuler un transfert par écriture inverse (administrateurs)' })
  async reverse(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseTransferDto,
    @Req() request: Request,
  ) {
    const admin = await this.users.getByIdOrThrow(current.id);
    return this.transfers.reverse(id, admin, dto.reason, this.context(request));
  }

  private context(request: Request) {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }
}
