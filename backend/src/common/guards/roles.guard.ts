import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { UserRole } from '@prisma/client';
import { BusinessError, ErrorCode } from '../errors/error-codes';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedUser } from '../decorators/current-user.decorator';

/**
 * Contrôle des rôles, à placer après le JwtAuthGuard.
 *
 * Le rôle vient de l'utilisateur rechargé en base par le JwtAuthGuard, donc
 * de la source de vérité — pas du corps de la requête, et pas même du jeton.
 * Un rôle retiré prend effet immédiatement.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user || !required.includes(user.role)) {
      throw new BusinessError(
        ErrorCode.FORBIDDEN,
        "Vous n'avez pas les droits nécessaires pour cette action.",
        403,
      );
    }

    return true;
  }
}
