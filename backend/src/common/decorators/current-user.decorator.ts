import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';
import { UserRole, UserStatus } from '@prisma/client';

/** Ce que le JwtAuthGuard attache à la requête après vérification du jeton. */
export interface AuthenticatedUser {
  id: string;
  phone: string;
  role: UserRole;
  status: UserStatus;
  kycLevel: number;
}

/**
 * Injecte l'utilisateur authentifié dans une méthode de contrôleur :
 *
 *   @Get('me')
 *   me(@CurrentUser() user: AuthenticatedUser) { ... }
 *
 * Évite de répéter `request.user` partout, et donne un type au passage.
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) return undefined;
    return data ? user[data] : user;
  },
);
