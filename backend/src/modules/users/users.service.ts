import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../database/prisma.service';

/**
 * Accès aux comptes utilisateurs.
 *
 * En PHASE 3, ce service reste volontairement minimal : de quoi authentifier.
 * Le profil, la gestion des statuts et la recherche viendront plus tard.
 */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findByPhone(phone: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { phone } });
  }

  async getByIdOrThrow(id: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new BusinessError(ErrorCode.NOT_FOUND, 'Utilisateur introuvable.', 404);
    }
    return user;
  }

  /**
   * Vue publique d'un compte.
   *
   * Ne renvoie JAMAIS pinHash ni passwordHash. C'est la raison d'être de cette
   * méthode : un `return user` distrait exposerait l'empreinte du PIN à
   * l'application mobile.
   */
  toPublicProfile(user: User) {
    return {
      id: user.id,
      phone: user.phone,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      status: user.status,
      kycLevel: user.kycLevel,
      phoneVerifiedAt: user.phoneVerifiedAt,
      createdAt: user.createdAt,
    };
  }

  /**
   * Identité réduite, pour confirmer un destinataire avant un envoi.
   *
   * « Hamze M. » : assez pour vérifier qu'on ne se trompe pas de personne,
   * pas assez pour constituer un annuaire (risque n°12, fuite de données
   * personnelles). Utilisé à partir de la PHASE 5.
   */
  toLimitedIdentity(user: Pick<User, 'firstName' | 'lastName'>) {
    return { displayName: `${user.firstName} ${user.lastName.charAt(0).toUpperCase()}.` };
  }
}
