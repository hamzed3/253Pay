import { randomInt } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OtpPurpose } from '@prisma/client';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';
import { HashingService } from '../../common/hashing/hashing.service';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../database/redis.service';
import { SMS_SENDER, SmsSender } from './sms/sms-sender';

interface StoredOtp {
  hash: string;
  attempts: number;
  auditId: string;
}

/**
 * Codes à usage unique.
 *
 * POURQUOI Redis ET PostgreSQL :
 *  - Redis détient le code actif. L'expiration y est native (TTL) : un code
 *    périmé disparaît tout seul, sans tâche de ménage à écrire ni à oublier.
 *  - PostgreSQL en garde une trace pour l'audit. Redis ne sait pas répondre à
 *    « combien d'OTP ce numéro a-t-il demandés le mois dernier ? », et c'est
 *    exactement la question que pose une enquête sur un compte détourné.
 *
 * Le code n'est stocké nulle part en clair — ni dans Redis, ni en base, ni
 * dans les logs (règle absolue n°7).
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger('OTP');

  private readonly length: number;
  private readonly ttlSeconds: number;
  private readonly maxAttempts: number;
  private readonly resendCooldownSeconds: number;
  private readonly maxPerPhonePerHour: number;
  private readonly maxPerIpPerHour: number;
  private readonly exposeInResponse: boolean;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    config: ConfigService,
  ) {
    this.length = config.get<number>('auth.otp.length', 6);
    this.ttlSeconds = config.get<number>('auth.otp.ttlSeconds', 300);
    this.maxAttempts = config.get<number>('auth.otp.maxAttempts', 3);
    this.resendCooldownSeconds = config.get<number>('auth.otp.resendCooldownSeconds', 60);
    this.maxPerPhonePerHour = config.get<number>('auth.otp.maxPerPhonePerHour', 5);
    this.maxPerIpPerHour = config.get<number>('auth.otp.maxPerIpPerHour', 20);
    this.exposeInResponse = config.get<boolean>('auth.otp.exposeInResponse', false);
  }

  /**
   * Génère, stocke et « envoie » un code.
   *
   * Renvoie le code en clair UNIQUEMENT si OTP_EXPOSE_IN_RESPONSE=true, ce qui
   * est impossible en production (bloqué par la validation d'environnement).
   */
  async request(
    phone: string,
    purpose: OtpPurpose,
    ip?: string,
  ): Promise<{ expiresInSeconds: number; devCode?: string }> {
    await this.assertQuotas(phone, purpose, ip);

    // randomInt utilise le générateur cryptographique du système.
    // Math.random() serait prévisible — donc inutilisable ici.
    const max = 10 ** this.length;
    const code = String(randomInt(0, max)).padStart(this.length, '0');
    const hash = await this.hashing.hashSecret(code);

    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);

    // Trace d'audit : le numéro et l'empreinte, jamais le code.
    const audit = await this.prisma.otp.create({
      data: { phone, codeHash: hash, purpose, expiresAt, ip },
      select: { id: true },
    });

    const stored: StoredOtp = { hash, attempts: 0, auditId: audit.id };
    await this.redis
      .getClient()
      .set(this.key(phone, purpose), JSON.stringify(stored), 'EX', this.ttlSeconds);

    await this.sms.send(
      phone,
      `253Pay : votre code de vérification est ${code}. Valable ${Math.round(this.ttlSeconds / 60)} minutes. Ne le communiquez à personne.`,
    );

    return {
      expiresInSeconds: this.ttlSeconds,
      ...(this.exposeInResponse ? { devCode: code } : {}),
    };
  }

  /**
   * Vérifie un code et le consomme.
   *
   * Un code valide est effacé immédiatement : il ne sert qu'une fois. Sans
   * cela, un code intercepté resterait utilisable pendant cinq minutes.
   */
  async verifyAndConsume(phone: string, purpose: OtpPurpose, code: string): Promise<void> {
    const key = this.key(phone, purpose);
    const raw = await this.redis.getClient().get(key);

    if (!raw) {
      // Expiré, déjà utilisé, ou jamais demandé : même message. Distinguer les
      // trois renseignerait un attaquant sur l'existence d'une demande en cours.
      throw new BusinessError(
        ErrorCode.OTP_EXPIRED,
        'Code expiré ou déjà utilisé. Demandez un nouveau code.',
      );
    }

    const stored = JSON.parse(raw) as StoredOtp;
    const valid = await this.hashing.verifySecret(stored.hash, code);

    if (!valid) {
      const attempts = stored.attempts + 1;

      if (attempts >= this.maxAttempts) {
        // Trop d'essais : le code est détruit. Il faut tout recommencer, ce qui
        // repasse par les quotas d'envoi.
        await this.redis.getClient().del(key);
        await this.markAudit(stored.auditId, attempts);
        throw new BusinessError(
          ErrorCode.TOO_MANY_ATTEMPTS,
          'Trop de tentatives. Demandez un nouveau code.',
          429,
        );
      }

      // On conserve le TTL restant : se tromper ne prolonge pas la validité.
      const ttl = await this.redis.getClient().ttl(key);
      await this.redis
        .getClient()
        .set(key, JSON.stringify({ ...stored, attempts }), 'EX', Math.max(ttl, 1));
      await this.markAudit(stored.auditId, attempts);

      throw new BusinessError(ErrorCode.OTP_INVALID, 'Code incorrect.', 400, {
        remainingAttempts: this.maxAttempts - attempts,
      });
    }

    await this.redis.getClient().del(key);
    await this.prisma.otp.update({
      where: { id: stored.auditId },
      data: { usedAt: new Date(), attempts: stored.attempts },
    });
  }

  /**
   * Quotas d'envoi — risque n°5 : l'abus d'OTP coûte de l'argent réel en SMS
   * et peut servir à harceler quelqu'un dont on connaît le numéro.
   */
  private async assertQuotas(phone: string, purpose: OtpPurpose, ip?: string): Promise<void> {
    const client = this.redis.getClient();

    // 1. Délai minimal entre deux envois DU MÊME TYPE.
    //
    // Pourquoi par type et non par numéro : un client qui vient de
    // réinitialiser son code par SMS doit pouvoir enchaîner sur la validation
    // de son appareil. Un délai global le bloquerait au pire moment, juste
    // après avoir oublié son code.
    // La dépense SMS reste bornée par le quota horaire ci-dessous, lui bien
    // calculé tous usages confondus.
    const cooldownKey = `otp:cooldown:${purpose}:${phone}`;
    const remaining = await client.ttl(cooldownKey);
    if (remaining > 0) {
      throw new BusinessError(
        ErrorCode.OTP_TOO_SOON,
        `Veuillez patienter ${remaining} secondes avant de demander un nouveau code.`,
        429,
        { retryAfterSeconds: remaining },
      );
    }

    // 2. Quota horaire par numéro.
    await this.assertHourlyQuota(`otp:quota:phone:${phone}`, this.maxPerPhonePerHour);

    // 3. Quota horaire par adresse IP : sans lui, un script parcourt tous les
    //    numéros du pays en changeant simplement de destinataire.
    if (ip) {
      await this.assertHourlyQuota(`otp:quota:ip:${ip}`, this.maxPerIpPerHour);
    }

    if (this.resendCooldownSeconds > 0) {
      await client.set(cooldownKey, '1', 'EX', this.resendCooldownSeconds);
    }
  }

  private async assertHourlyQuota(key: string, max: number): Promise<void> {
    const client = this.redis.getClient();
    const count = await client.incr(key);

    // Le TTL n'est posé qu'au premier incrément : la fenêtre d'une heure
    // démarre à la première demande et ne se prolonge pas indéfiniment.
    if (count === 1) await client.expire(key, 3600);

    if (count > max) {
      this.logger.warn(`Quota OTP dépassé (${key.split(':').slice(0, 3).join(':')})`);
      throw new BusinessError(
        ErrorCode.TOO_MANY_ATTEMPTS,
        'Trop de demandes de code. Réessayez dans une heure.',
        429,
      );
    }
  }

  private async markAudit(auditId: string, attempts: number): Promise<void> {
    await this.prisma.otp.update({ where: { id: auditId }, data: { attempts } });
  }

  private key(phone: string, purpose: OtpPurpose): string {
    return `otp:${purpose}:${phone}`;
  }
}
