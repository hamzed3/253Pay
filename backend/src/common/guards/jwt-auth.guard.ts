import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { BusinessError, ErrorCode } from '../errors/error-codes';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthenticatedUser } from '../decorators/current-user.decorator';
import { PrismaService } from '../../database/prisma.service';

/** Contenu du jeton d'accès. Volontairement minimal. */
export interface AccessTokenPayload {
  sub: string;
  role: string;
  jti: string;
}

/**
 * Garde d'authentification, appliqué GLOBALEMENT (voir app.module.ts).
 *
 * Deux vérifications, et non une seule :
 *
 * 1. la signature du jeton est valide et il n'est pas expiré ;
 * 2. l'utilisateur existe TOUJOURS et son compte est TOUJOURS actif.
 *
 * Le point 2 coûte une requête en base à chaque appel. C'est assumé : sans
 * lui, un compte bloqué pour fraude continuerait d'agir pendant les 15 minutes
 * de validité de son jeton. Sur une API financière, 15 minutes suffisent à
 * vider des comptes. Si cette requête devient un goulot d'étranglement, la
 * réponse est un cache Redis de quelques secondes — pas la suppression du
 * contrôle.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const token = this.extractToken(request);

    if (!token) {
      throw new BusinessError(ErrorCode.UNAUTHENTICATED, 'Authentification requise.', 401);
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      // On ne dit pas SI le jeton est expiré ou mal signé : c'est une
      // information utile à un attaquant, inutile à un client honnête.
      throw new BusinessError(ErrorCode.TOKEN_INVALID, 'Session invalide ou expirée.', 401);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, phone: true, role: true, status: true, kycLevel: true },
    });

    if (!user) {
      throw new BusinessError(ErrorCode.TOKEN_INVALID, 'Session invalide.', 401);
    }

    if (user.status === 'BLOCKED' || user.status === 'CLOSED') {
      throw new BusinessError(ErrorCode.ACCOUNT_BLOCKED, 'Ce compte est bloqué.', 403);
    }

    if (user.status !== 'ACTIVE') {
      throw new BusinessError(ErrorCode.ACCOUNT_NOT_ACTIVE, "Ce compte n'est pas actif.", 403);
    }

    request.user = user;
    return true;
  }

  private extractToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) return undefined;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' ? value : undefined;
  }
}
