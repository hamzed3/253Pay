import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { Money } from '../../common/money/money';
import { UsersService } from '../users/users.service';
import { DepositsService } from './deposits.service';
import { CreateDepositDto, QuoteDepositDto } from './dto/deposit.dto';

@ApiTags('deposits')
@ApiBearerAuth()
@Controller('deposits')
export class DepositsController {
  constructor(
    private readonly deposits: DepositsService,
    private readonly users: UsersService,
  ) {}

  @Post('quote')
  @HttpCode(200)
  @ApiOperation({ summary: 'Simuler un dépôt : montant remis, frais, montant crédité' })
  async quote(@CurrentUser() current: AuthenticatedUser, @Body() dto: QuoteDepositDto) {
    const user = await this.users.getByIdOrThrow(current.id);
    return this.deposits.quote(user, Money.fromMajor(dto.amount));
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Demander un dépôt — reste en attente jusqu’à confirmation' })
  initiate(
    @CurrentUser() current: AuthenticatedUser,
    @Body() dto: CreateDepositDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() request: Request,
  ) {
    return this.deposits.initiate(current.id, dto, idempotencyKey, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'État d’un de mes dépôts' })
  get(@CurrentUser() current: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.deposits.getForUser(current.id, id);
  }
}
