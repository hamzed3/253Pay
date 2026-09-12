import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import {
  ChangePinDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  RequestOtpDto,
  ResetPinDto,
  VerifyLoginOtpDto,
} from './dto/auth.dto';

/**
 * Routes d'authentification.
 *
 * Toutes sont @Public sauf celles qui exigent une session : le JwtAuthGuard
 * est global, donc tout est fermé par défaut.
 *
 * Les limites de débit sont volontairement plus strictes qu'ailleurs : c'est
 * ici qu'on tente la force brute sur un PIN (risque n°4) et l'abus d'envoi de
 * SMS (risque n°5).
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  @Public()
  @Post('otp/request')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Demander un code de vérification par SMS' })
  requestOtp(@Body() dto: RequestOtpDto, @Req() request: Request) {
    return this.auth.requestOtp(dto, this.context(request));
  }

  @Public()
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Créer un compte après vérification du numéro' })
  register(@Body() dto: RegisterDto, @Req() request: Request) {
    return this.auth.register(dto, this.context(request));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Se connecter avec un numéro et un code secret' })
  login(@Body() dto: LoginDto, @Req() request: Request) {
    return this.auth.login(dto, this.context(request));
  }

  @Public()
  @Post('login/verify-otp')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Valider un nouvel appareil et terminer la connexion' })
  verifyLoginOtp(@Body() dto: VerifyLoginOtpDto, @Req() request: Request) {
    return this.auth.verifyLoginOtp(dto, this.context(request));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Renouveler la session (rotation du jeton)' })
  refresh(@Body() dto: RefreshDto, @Req() request: Request) {
    return this.auth.refresh(dto.refreshToken, this.context(request));
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Fermer la session de cet appareil' })
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @Public()
  @Post('pin/reset')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Réinitialiser son code secret oublié, via SMS' })
  resetPin(@Body() dto: ResetPinDto, @Req() request: Request) {
    return this.auth.resetPin(dto, this.context(request));
  }

  // --- Routes protégées : un jeton d'accès valide est requis ---

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Profil de l’utilisateur connecté' })
  async me(@CurrentUser() current: AuthenticatedUser) {
    const user = await this.users.getByIdOrThrow(current.id);
    return this.users.toPublicProfile(user);
  }

  @Post('pin/change')
  @HttpCode(200)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Changer son code secret' })
  changePin(
    @CurrentUser() current: AuthenticatedUser,
    @Body() dto: ChangePinDto,
    @Req() request: Request,
  ) {
    return this.auth.changePin(current.id, dto, this.context(request));
  }

  @Post('logout-all')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Fermer toutes les sessions, sur tous les appareils' })
  logoutAll(@CurrentUser() current: AuthenticatedUser, @Req() request: Request) {
    return this.auth.logoutAll(current, this.context(request));
  }

  /** IP et user-agent servent aux quotas et à l'audit, jamais à autoriser. */
  private context(request: Request) {
    return {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    };
  }
}
