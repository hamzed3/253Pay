import { Global, Module } from '@nestjs/common';
import { FeesService } from './fees.service';

@Global()
@Module({
  providers: [FeesService],
  exports: [FeesService],
})
export class FeesModule {}
