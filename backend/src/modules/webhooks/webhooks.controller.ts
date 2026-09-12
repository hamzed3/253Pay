import { Controller, HttpCode, Param, Post, RawBodyRequest, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';
import { Public } from '../../common/decorators/public.decorator';
import { ProviderRegistry } from '../payments/provider-registry.service';
import { WebhooksService } from './webhooks.service';

/**
 * POST /api/webhooks/:providerCode
 *
 * Route PUBLIQUE : un partenaire n'a pas de jeton JWT. Ce n'est pas une
 * faiblesse tant que la signature tient lieu d'authentification — c'est
 * pourquoi elle est vérifiée avant tout, sur le corps BRUT.
 *
 * Non soumise à la limite de débit : un partenaire qui réessaie en rafale
 * après un incident ne doit pas être bloqué, sinon des confirmations de
 * paiement seraient perdues.
 */
@ApiExcludeController()
@Controller('webhooks')
@Public()
@SkipThrottle()
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly providers: ProviderRegistry,
  ) {}

  @Post(':providerCode')
  @HttpCode(200)
  handle(@Param('providerCode') providerCode: string, @Req() request: RawBodyRequest<Request>) {
    const provider = this.providers.find(providerCode);

    if (!provider) {
      throw new BusinessError(ErrorCode.PROVIDER_UNAVAILABLE, 'Fournisseur inconnu.', 404);
    }

    // Le corps BRUT, pas l'objet analysé : re-sérialiser du JSON ne redonne pas
    // les mêmes octets (ordre des clés, espaces) et la signature ne
    // correspondrait plus. Activé par `rawBody: true` au démarrage.
    const rawBody = request.rawBody;

    if (!rawBody) {
      throw new BusinessError(
        ErrorCode.INTERNAL_ERROR,
        "Corps brut indisponible : l'application doit démarrer avec rawBody activé.",
        500,
      );
    }

    const signature = request.headers[provider.signatureHeader];

    return this.webhooks.handle(
      providerCode,
      rawBody,
      Array.isArray(signature) ? signature[0] : signature,
    );
  }
}
