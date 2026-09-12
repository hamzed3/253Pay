import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';
import { HashingService } from '../../common/hashing/hashing.service';
import { PrismaService } from '../../database/prisma.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Durée de validité du jeton d'accès, telle que configurée (ex. « 15m »). */
  expiresIn: string | number;
}

interface IssueContext {
  deviceId?: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Jetons d'accès et de renouvellement.
 *
 * DEUX JETONS, DEUX RÔLES :
 *
 * - Le jeton d'ACCÈS est un JWT signé, valable 15 minutes. Il n'est stocké
 *   nulle part côté serveur : sa signature suffit à le vérifier. C'est ce qui
 *   rend l'API rapide — mais aussi ce qui empêche de le révoquer. D'où sa
 *   durée de vie très courte : un jeton volé n'est exploitable qu'un quart
 *   d'heure.
 *
 * - Le jeton de RENOUVELLEMENT est une simple valeur aléatoire de 512 bits,
 *   valable 30 jours, dont seule l'empreinte est en base. Lui est révocable
 *   à tout instant.
 *
 * LA ROTATION : chaque renouvellement consomme l'ancien jeton et en émet un
 * nouveau. Un jeton ne sert donc qu'une fois.
 *
 * LA DÉTECTION DE RÉUTILISATION : si un jeton déjà consommé se représente,
 * c'est qu'il en existe une copie — donc un vol. On ne peut pas savoir qui du
 * voleur ou du client légitime se présente, alors on révoque TOUTE la chaîne.
 * Le client devra se reconnecter ; le voleur, lui, est dehors.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger('Tokens');

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
  ) {}

  async issuePair(user: Pick<User, 'id' | 'role'>, context: IssueContext = {}): Promise<TokenPair> {
    const accessTtl = this.readTtl('JWT_ACCESS_TTL', '15m');

    const accessToken = await this.jwt.signAsync(
      {
        sub: user.id,
        role: user.role,
        // Identifiant unique du jeton : utile pour tracer un appel précis
        // dans les journaux sans exposer de donnée personnelle.
        jti: randomBytes(16).toString('hex'),
      },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: accessTtl.value,
      },
    );

    const refreshToken = await this.createRefreshToken(user.id, context);

    return { accessToken, refreshToken, expiresIn: accessTtl.value };
  }

  /**
   * Échange un jeton de renouvellement contre une nouvelle paire.
   * C'est ici que vivent la rotation et la détection de réutilisation.
   */
  async rotate(presentedToken: string, context: IssueContext = {}): Promise<TokenPair> {
    const tokenHash = this.hashing.hashToken(presentedToken);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, role: true, status: true } } },
    });

    if (!stored) {
      throw new BusinessError(ErrorCode.TOKEN_INVALID, 'Session invalide. Reconnectez-vous.', 401);
    }

    // Un jeton déjà révoqué qui revient = une copie circule.
    if (stored.revokedAt) {
      this.logger.error(
        `Réutilisation d'un jeton de renouvellement détectée pour l'utilisateur ${stored.userId} — révocation de toutes ses sessions`,
      );
      await this.revokeAllForUser(stored.userId);
      throw new BusinessError(
        ErrorCode.TOKEN_REUSED,
        'Anomalie de sécurité détectée. Toutes vos sessions ont été fermées, reconnectez-vous.',
        401,
      );
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new BusinessError(ErrorCode.TOKEN_INVALID, 'Session expirée. Reconnectez-vous.', 401);
    }

    if (stored.user.status !== 'ACTIVE') {
      throw new BusinessError(ErrorCode.ACCOUNT_BLOCKED, "Ce compte n'est plus actif.", 403);
    }

    const accessTtl = this.readTtl('JWT_ACCESS_TTL', '15m');
    const accessToken = await this.jwt.signAsync(
      { sub: stored.user.id, role: stored.user.role, jti: randomBytes(16).toString('hex') },
      { secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: accessTtl.value },
    );

    const refreshToken = await this.createRefreshToken(stored.userId, {
      deviceId: stored.deviceId ?? context.deviceId,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    // L'ancien est marqué consommé ET relié au nouveau : la chaîne reste
    // reconstituable lors d'une enquête.
    const created = await this.prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: this.hashing.hashToken(refreshToken) },
      select: { id: true },
    });

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedById: created.id },
    });

    return { accessToken, refreshToken, expiresIn: accessTtl.value };
  }

  /** Déconnexion d'un seul appareil. */
  async revoke(presentedToken: string): Promise<void> {
    const tokenHash = this.hashing.hashToken(presentedToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    // Silencieux si le jeton est inconnu : se déconnecter deux fois n'est pas
    // une erreur, et répondre « ce jeton n'existe pas » renseignerait un tiers.
    if (!stored || stored.revokedAt) return;

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
  }

  /** Déconnexion de tous les appareils (changement de PIN, vol détecté…). */
  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  private async createRefreshToken(userId: string, context: IssueContext): Promise<string> {
    // 64 octets = 512 bits d'aléa cryptographique. Indevinable.
    const token = randomBytes(64).toString('hex');

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashing.hashToken(token),
        deviceId: context.deviceId,
        ip: context.ip,
        userAgent: context.userAgent?.slice(0, 255),
        expiresAt: new Date(Date.now() + this.readTtl('JWT_REFRESH_TTL', '30d').milliseconds),
      },
    });

    return token;
  }

  /**
   * Lit et VALIDE une durée de configuration (« 30d », « 12h », « 45m »,
   * « 90s »), et la renvoie sous les deux formes dont on a besoin.
   *
   * La validation n'est pas décorative : `expiresIn` attend un type littéral
   * que TypeScript ne peut pas déduire d'une variable lue à l'exécution. On
   * vérifie donc le format nous-mêmes, ce qui rend la conversion de type
   * honnête — et transforme une faute de frappe dans .env en message clair
   * plutôt qu'en jeton à durée de vie fantaisiste.
   */
  private readTtl(variable: 'JWT_ACCESS_TTL' | 'JWT_REFRESH_TTL', fallback: string) {
    const raw = this.config.get<string>(variable, fallback).trim();
    const match = /^(\d+)([smhd])$/.exec(raw);

    if (!match) {
      throw new BusinessError(
        ErrorCode.INTERNAL_ERROR,
        `${variable} invalide : « ${raw} ». Format attendu : 30d, 12h, 45m ou 90s.`,
        500,
      );
    }

    const factors: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

    return {
      value: raw as NonNullable<JwtSignOptions['expiresIn']>,
      milliseconds: Number(match[1]) * factors[match[2]],
    };
  }
}
