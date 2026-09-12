import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Restreint une route à certains rôles : @Roles('ADMIN')
 *
 * Le rôle est lu dans le JETON, jamais dans le corps de la requête (risque
 * n°7 du document d'architecture : escalade de privilèges). Un client qui
 * enverrait { "role": "ADMIN" } n'obtiendrait rien.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
