import { Injectable, Logger } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { maskSensitive } from '../../common/interceptors/logging.interceptor';

export interface AuditEntry {
  actorId?: string | null;
  actorRole?: UserRole | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
  reason?: string;
}

/**
 * Journal des actions sensibles.
 *
 * « Ce qui n'est pas journalisé n'existe pas. » Le jour où un client conteste
 * une opération, ou qu'un régulateur demande qui a fait quoi, cette table est
 * la seule réponse possible.
 *
 * Deux précautions :
 *
 * 1. Les champs sensibles (PIN, OTP, jetons…) sont masqués AVANT écriture.
 *    Un journal d'audit qui contient des PIN est une base de mots de passe.
 * 2. Un échec d'écriture ne fait jamais échouer l'action journalisée. Ne pas
 *    pouvoir écrire une ligne d'audit est un incident à signaler, pas une
 *    raison de refuser une connexion légitime.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: entry.actorId ?? null,
          actorRole: entry.actorRole ?? null,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          before: this.sanitize(entry.before),
          after: this.sanitize(entry.after),
          ip: entry.ip,
          userAgent: entry.userAgent?.slice(0, 255),
          reason: entry.reason?.slice(0, 255),
        },
      });
    } catch (error) {
      this.logger.error(
        `Impossible d'écrire l'audit « ${entry.action} » : ${(error as Error).message}`,
      );
    }
  }

  private sanitize(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined || value === null) return undefined;
    return maskSensitive(value) as Prisma.InputJsonValue;
  }
}
