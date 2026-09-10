import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OtpPurpose, User } from '@prisma/client';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';
import { normalizePhone } from '../../common/phone/phone';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { UsersService } from '../users/users.service';
import { OtpService } from './otp.service';
import { PinService } from './pin.service';
import { TokenPair, TokenService } from './token.service';
import {
  ChangePinDto,
  DeviceDto,
  LoginDto,
  RegisterDto,
  RequestOtpDto,
  ResetPinDto,
  VerifyLoginOtpDto,
} from './dto/auth.dto';

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger('Auth');

  /**
   * Empreinte factice, calculée une fois au démarrage.
   *
   * POURQUOI : vérifier un PIN avec Argon2id prend ~50 ms. Si l'on répondait
   * immédiatement « numéro inconnu » sans rien vérifier, la différence de
   * temps de réponse suffirait à savoir quels numéros ont un compte chez
   * 253Pay. On fait donc travailler Argon2 exactement pareil dans les deux
   * cas. Cette empreinte doit être RÉELLE : un texte inventé serait rejeté
   * instantanément par Argon2, et l'écart réapparaîtrait.
   */
  private dummyPinHash!: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly otp: OtpService,
    private readonly pin: PinService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyPinHash = await this.pin.hash('0000000000000000');
  }

  // -------------------------------------------------------------------
  // Envoi d'un code
  // -------------------------------------------------------------------

  async requestOtp(dto: RequestOtpDto, context: RequestContext) {
    const phone = normalizePhone(dto.phone);
    const existing = await this.users.findByPhone(phone);

    // On NE DIT PAS si le numéro est déjà inscrit.
    //
    // Répondre « ce numéro existe déjà » transformerait cette route en
    // annuaire : un script testerait tous les numéros du pays pour savoir qui
    // est client de 253Pay. La réponse est donc identique dans tous les cas.
    // La cohérence est vérifiée plus tard, à l'étape qui consomme le code.
    if (dto.purpose === OtpPurpose.REGISTRATION && existing) {
      this.logger.warn('Demande de code d’inscription sur un numéro déjà inscrit');
    }

    const result = await this.otp.request(phone, dto.purpose, context.ip);

    return {
      message: 'Si ce numéro est valide, un code vient de lui être envoyé.',
      expiresInSeconds: result.expiresInSeconds,
      ...(result.devCode ? { devCode: result.devCode } : {}),
    };
  }

  // -------------------------------------------------------------------
  // Inscription
  // -------------------------------------------------------------------

  async register(dto: RegisterDto, context: RequestContext): Promise<TokenPair & { user: object }> {
    const phone = normalizePhone(dto.phone);

    // Le PIN est validé AVANT de consommer le code : sinon un client au PIN
    // trop faible perdrait son code et devrait tout recommencer.
    this.pin.assertStrongEnough(dto.pin, phone);

    if (await this.users.findByPhone(phone)) {
      throw new BusinessError(
        ErrorCode.USER_ALREADY_EXISTS,
        'Un compte existe déjà pour ce numéro. Connectez-vous.',
        409,
      );
    }

    await this.otp.verifyAndConsume(phone, OtpPurpose.REGISTRATION, dto.code);

    const pinHash = await this.pin.hash(dto.pin);

    const user = await this.prisma.user.create({
      data: {
        phone,
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        pinHash,
        // Le code reçu par SMS prouve que le numéro appartient bien au client :
        // le compte est donc actif immédiatement.
        status: 'ACTIVE',
        phoneVerifiedAt: new Date(),
        devices: {
          create: {
            deviceId: dto.device.deviceId,
            platform: dto.device.platform,
            model: dto.device.model,
            // L'appareil qui a servi à l'inscription est de confiance.
            trusted: true,
          },
        },
      },
    });

    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: 'AUTH_REGISTER',
      entityType: 'User',
      entityId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    const pair = await this.tokens.issuePair(user, {
      deviceId: dto.device.deviceId,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    // PHASE 4 : c'est ici que sera créé le portefeuille du client, avec son
    // compte de ledger. Aucun portefeuille n'existe pour l'instant.
    return { ...pair, user: this.users.toPublicProfile(user) };
  }

  // -------------------------------------------------------------------
  // Connexion
  // -------------------------------------------------------------------

  async login(dto: LoginDto, context: RequestContext) {
    const phone = normalizePhone(dto.phone);
    const user = await this.users.findByPhone(phone);

    // Compte inexistant et PIN faux donnent la MÊME réponse. Distinguer les
    // deux permettrait de découvrir qui possède un compte.
    if (!user) {
      // On vérifie tout de même un PIN factice : sans cela, la réponse serait
      // instantanée pour un numéro inconnu et lente pour un numéro connu.
      // Ce simple écart de temps trahirait l'existence du compte.
      await this.pin.verify(this.dummyPinHash, dto.pin);
      throw new BusinessError(ErrorCode.INVALID_CREDENTIALS, 'Numéro ou code incorrect.', 401);
    }

    this.assertUsable(user);

    const valid = await this.pin.verify(user.pinHash, dto.pin);

    if (!valid) {
      await this.registerFailedPin(user, context);
      throw new BusinessError(ErrorCode.INVALID_CREDENTIALS, 'Numéro ou code incorrect.', 401);
    }

    // PIN correct : le compteur repart à zéro.
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedPinAttempts: 0, blockedUntil: null, lastLoginAt: new Date() },
    });

    const device = await this.prisma.device.findUnique({
      where: { userId_deviceId: { userId: user.id, deviceId: dto.device.deviceId } },
    });

    // Appareil inconnu : le PIN ne suffit pas.
    //
    // C'est la parade au risque n°8 (vol de token) et, plus concrètement, au
    // téléphone volé : connaître le PIN ne permet pas de se connecter depuis
    // un autre appareil sans accès au SMS.
    if (!device?.trusted) {
      await this.otp.request(phone, OtpPurpose.LOGIN, context.ip);
      await this.audit.record({
        actorId: user.id,
        actorRole: user.role,
        action: 'AUTH_LOGIN_NEW_DEVICE',
        entityType: 'User',
        entityId: user.id,
        ip: context.ip,
        userAgent: context.userAgent,
        reason: 'Appareil inconnu, code de vérification demandé',
      });

      return {
        otpRequired: true,
        message: 'Nouvel appareil détecté. Un code de vérification vous a été envoyé.',
      };
    }

    await this.touchDevice(user.id, dto.device);
    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: 'AUTH_LOGIN',
      entityType: 'User',
      entityId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    const pair = await this.tokens.issuePair(user, {
      deviceId: dto.device.deviceId,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return { otpRequired: false, ...pair, user: this.users.toPublicProfile(user) };
  }

  /** Deuxième étape de connexion depuis un appareil inconnu. */
  async verifyLoginOtp(dto: VerifyLoginOtpDto, context: RequestContext) {
    const phone = normalizePhone(dto.phone);
    const user = await this.users.findByPhone(phone);

    if (!user) {
      throw new BusinessError(ErrorCode.OTP_INVALID, 'Code incorrect.', 400);
    }

    this.assertUsable(user);
    await this.otp.verifyAndConsume(phone, OtpPurpose.LOGIN, dto.code);

    await this.touchDevice(user.id, dto.device, true);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedPinAttempts: 0, blockedUntil: null, lastLoginAt: new Date() },
    });

    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: 'AUTH_DEVICE_TRUSTED',
      entityType: 'Device',
      entityId: dto.device.deviceId,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    const pair = await this.tokens.issuePair(user, {
      deviceId: dto.device.deviceId,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return { ...pair, user: this.users.toPublicProfile(user) };
  }

  // -------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------

  refresh(refreshToken: string, context: RequestContext): Promise<TokenPair> {
    return this.tokens.rotate(refreshToken, context);
  }

  async logout(refreshToken: string): Promise<{ message: string }> {
    await this.tokens.revoke(refreshToken);
    return { message: 'Session fermée.' };
  }

  async logoutAll(user: { id: string }, context: RequestContext) {
    const count = await this.tokens.revokeAllForUser(user.id);
    await this.audit.record({
      actorId: user.id,
      action: 'AUTH_LOGOUT_ALL',
      entityType: 'User',
      entityId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });
    return { message: `${count} session(s) fermée(s).` };
  }

  // -------------------------------------------------------------------
  // Code secret
  // -------------------------------------------------------------------

  async changePin(userId: string, dto: ChangePinDto, context: RequestContext) {
    const user = await this.users.getByIdOrThrow(userId);

    if (!(await this.pin.verify(user.pinHash, dto.currentPin))) {
      await this.registerFailedPin(user, context);
      throw new BusinessError(ErrorCode.INVALID_CREDENTIALS, 'Code actuel incorrect.', 401);
    }

    this.pin.assertStrongEnough(dto.newPin, user.phone);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { pinHash: await this.pin.hash(dto.newPin), failedPinAttempts: 0, blockedUntil: null },
    });

    // Un changement de code ferme toutes les sessions : si le PIN a été changé
    // parce qu'il était compromis, laisser les anciennes sessions ouvertes
    // annulerait tout le bénéfice de l'opération.
    const revoked = await this.tokens.revokeAllForUser(user.id);

    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: 'AUTH_PIN_CHANGED',
      entityType: 'User',
      entityId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return { message: `Code modifié. ${revoked} session(s) fermée(s), reconnectez-vous.` };
  }

  async resetPin(dto: ResetPinDto, context: RequestContext) {
    const phone = normalizePhone(dto.phone);
    const user = await this.users.findByPhone(phone);

    if (!user) {
      throw new BusinessError(ErrorCode.OTP_INVALID, 'Code incorrect.', 400);
    }

    this.pin.assertStrongEnough(dto.newPin, phone);
    await this.otp.verifyAndConsume(phone, OtpPurpose.PIN_RESET, dto.code);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        pinHash: await this.pin.hash(dto.newPin),
        failedPinAttempts: 0,
        // La réinitialisation par SMS lève aussi le blocage : c'est la porte de
        // sortie du client honnête qui a oublié son code.
        blockedUntil: null,
      },
    });

    const revoked = await this.tokens.revokeAllForUser(user.id);

    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: 'AUTH_PIN_RESET',
      entityType: 'User',
      entityId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return { message: `Code réinitialisé. ${revoked} session(s) fermée(s), reconnectez-vous.` };
  }

  // -------------------------------------------------------------------
  // Utilitaires internes
  // -------------------------------------------------------------------

  /** Refuse un compte bloqué, suspendu, fermé ou en cours de blocage. */
  private assertUsable(user: User): void {
    if (user.blockedUntil && user.blockedUntil.getTime() > Date.now()) {
      const minutes = this.pin.remainingLockMinutes(user.blockedUntil);
      throw new BusinessError(
        ErrorCode.ACCOUNT_BLOCKED,
        `Trop de tentatives. Réessayez dans ${minutes} minute(s) ou réinitialisez votre code.`,
        423,
        { retryAfterMinutes: minutes },
      );
    }

    if (user.status === 'BLOCKED' || user.status === 'CLOSED') {
      throw new BusinessError(ErrorCode.ACCOUNT_BLOCKED, 'Ce compte est bloqué.', 403);
    }

    if (user.status !== 'ACTIVE') {
      throw new BusinessError(ErrorCode.ACCOUNT_NOT_ACTIVE, "Ce compte n'est pas actif.", 403);
    }
  }

  private async registerFailedPin(user: User, context: RequestContext): Promise<void> {
    const state = this.pin.nextLockState(user.failedPinAttempts);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedPinAttempts: state.failedAttempts, blockedUntil: state.blockedUntil },
    });

    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: state.blockedUntil ? 'AUTH_ACCOUNT_LOCKED' : 'AUTH_PIN_FAILED',
      entityType: 'User',
      entityId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
      reason: `Tentative ${state.failedAttempts}`,
    });
  }

  private async touchDevice(userId: string, device: DeviceDto, trust = false): Promise<void> {
    await this.prisma.device.upsert({
      where: { userId_deviceId: { userId, deviceId: device.deviceId } },
      update: {
        lastSeenAt: new Date(),
        platform: device.platform,
        model: device.model,
        ...(trust ? { trusted: true } : {}),
      },
      create: {
        userId,
        deviceId: device.deviceId,
        platform: device.platform,
        model: device.model,
        trusted: trust,
      },
    });
  }
}
