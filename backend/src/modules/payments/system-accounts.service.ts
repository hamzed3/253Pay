import { Injectable } from '@nestjs/common';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../database/prisma.service';

/** Les comptes du plan comptable système, chargés par `npm run prisma:seed`. */
export type SystemAccountCode =
  'SYSTEM_CASH' | 'SYSTEM_REVENUE' | 'SYSTEM_COMMISSION' | 'SYSTEM_SUSPENSE';

/**
 * Retrouve les comptes système par leur code.
 *
 * Ils ne changent jamais une fois créés : on les met donc en cache mémoire
 * plutôt que d'interroger la base à chaque opération.
 */
@Injectable()
export class SystemAccountsService {
  private readonly cache = new Map<SystemAccountCode, string>();

  constructor(private readonly prisma: PrismaService) {}

  async id(code: SystemAccountCode): Promise<string> {
    const connu = this.cache.get(code);
    if (connu) return connu;

    const account = await this.prisma.ledgerAccount.findUnique({ where: { code } });

    if (!account) {
      // L'absence d'un compte système est une erreur d'installation, pas une
      // erreur du client : le message doit donc dire quoi faire.
      throw new BusinessError(
        ErrorCode.INTERNAL_ERROR,
        `Compte système ${code} absent. Avez-vous lancé « npm run prisma:seed » ?`,
        500,
      );
    }

    this.cache.set(code, account.id);
    return account.id;
  }
}
