import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module';
import { WalletsModule } from '../wallets/wallets.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { PinService } from './pin.service';
import { TokenService } from './token.service';
import { MockSmsSender, SMS_SENDER } from './sms/sms-sender';

@Module({
  imports: [
    UsersModule,
    WalletsModule,
    // Les secrets sont passés explicitement à chaque signature/vérification
    // (voir TokenService et JwtAuthGuard) : l'accès et le renouvellement
    // n'utilisent pas la même clé, un module configuré globalement les
    // mélangerait.
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    OtpService,
    PinService,
    TokenService,
    // L'envoi de SMS passe par une interface : le jour où un opérateur est
    // sous contrat, seule cette ligne change.
    { provide: SMS_SENDER, useClass: MockSmsSender },
  ],
  exports: [TokenService],
})
export class AuthModule {}
