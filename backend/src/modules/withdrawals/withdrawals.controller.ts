import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { Money } from '../../common/money/money';
import { UsersService } from '../users/users.service';
import { CreateWithdrawalDto, QuoteWithdrawalDto } from './dto/withdrawal.dto';
import { WithdrawalsService } from './withdrawals.service';

@ApiTags('withdrawals')
@ApiBearerAuth()
@Controller('withdrawals')
export class WithdrawalsController {
  constructor(
    private readonly withdrawals: WithdrawalsService,
    private readonly users: UsersService,
  ) {}

  @Post('quote')
  @HttpCode(200)
  @ApiOperation({ summary: 'Simuler un retrait : montant reçu, frais, total débité' })
  async quote(@CurrentUser() current: AuthenticatedUser, @Body() dto: QuoteWithdrawalDto) {
    const user = await this.users.getByIdOrThrow(current.id);
    return this.withdrawals.quote(user, Money.fromMajor(dto.amount));
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Demander un retrait — l’argent quitte le compte immédiatement' })
  initiate(
    @CurrentUser() current: AuthenticatedUser,
    @Body() dto: CreateWithdrawalDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() request: Request,
  ) {
    return this.withdrawals.initiate(current.id, dto, idempotencyKey, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'État d’un de mes retraits' })
  get(@CurrentUser() current: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.withdrawals.getForUser(current.id, id);
  }
}
