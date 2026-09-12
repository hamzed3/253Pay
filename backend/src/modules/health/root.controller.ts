import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';

/**
 * GET /
 *
 * La racine renvoyait un 404 nu. Quelqu'un ouvrant l'adresse du service dans
 * un navigateur n'avait donc aucun moyen de savoir ce qu'il venait
 * d'atteindre, ni où se trouvait la documentation.
 *
 * Ce point d'entrée ne fait rien d'autre que se présenter. Il ne touche à
 * aucune donnée, ne lit pas la base, et n'expose aucune information que
 * Swagger ne donne pas déjà.
 *
 * ⚠️ À NE PAS CONFONDRE avec une page d'accueil : 253Pay n'a pas de site web.
 * Le backend est une API ; l'application cliente est en Flutter (à venir) et
 * le dashboard admin en Next.js (PHASE 11). Ce dépôt ne contient ni l'un ni
 * l'autre.
 */
@ApiTags('health')
@Controller()
@SkipThrottle()
// Le JwtAuthGuard est global : sans @Public, la racine répondrait 401.
@Public()
export class RootController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  @ApiOperation({ summary: 'Identification du service' })
  index() {
    const apiPrefix = this.config.get<string>('apiPrefix', 'api');
    const isProduction = this.config.get<boolean>('isProduction');

    return {
      service: '253Pay API',
      version: process.env.npm_package_version ?? '0.1.0',
      status: 'ok',
      message:
        "Ceci est l'API de 253Pay, pas un site web. Les applications client et " +
        'administrateur sont des projets distincts.',
      endpoints: {
        health: '/health',
        // La documentation est désactivée en production : annoncer une adresse
        // qui répondrait 404 serait plus déroutant que de ne rien annoncer.
        documentation: isProduction ? null : `/${apiPrefix}/docs`,
      },
      timestamp: new Date().toISOString(),
    };
  }
}
