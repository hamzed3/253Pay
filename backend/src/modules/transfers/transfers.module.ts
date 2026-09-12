import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

@Module({
  // AuthModule fournit PinService : la confirmation d'un transfert passe par le
  // même contrôle, et surtout le même compteur d'échecs, que la connexion.
  imports: [UsersModule, AuthModule],
  controllers: [TransfersController],
  providers: [TransfersService],
})
export class TransfersModule {}
