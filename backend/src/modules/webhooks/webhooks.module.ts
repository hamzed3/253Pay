import { Module } from '@nestjs/common';
import { DepositsModule } from '../deposits/deposits.module';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [DepositsModule, WithdrawalsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
