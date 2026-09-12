import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';
import { BusinessError, ErrorCode } from '../errors/error-codes';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Lit l'en-tête `Idempotency-Key`, obligatoire sur toute opération financière
 * (règle absolue n°5).
 *
 * LE SCÉNARIO QU'IL FAUT AVOIR EN TÊTE : le client appuie sur « Envoyer », le
 * réseau coupe avant la réponse. Il ne sait pas si l'argent est parti. Il
 * réappuie. Sans clé, c'est un second transfert.
 *
 * ⚠️ La clé doit être générée AVANT le premier envoi et RÉUTILISÉE à chaque
 * nouvelle tentative. Une application qui en génère une nouvelle à chaque appui
 * annule complètement la protection.
 *
 * L'en-tête est exigé plutôt que déduit : mieux vaut refuser une requête
 * bruyamment que d'exécuter un paiement sans filet.
 */
export const IdempotencyKey = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<Request>();
  const value = request.headers[IDEMPOTENCY_HEADER];
  const key = Array.isArray(value) ? value[0] : value;

  if (!key || key.trim().length < 8) {
    throw new BusinessError(
      ErrorCode.VALIDATION_FAILED,
      "En-tête Idempotency-Key requis (au moins 8 caractères). Générez-le AVANT l'envoi et réutilisez-le à chaque nouvelle tentative.",
      400,
    );
  }

  if (key.length > 100) {
    throw new BusinessError(
      ErrorCode.VALIDATION_FAILED,
      'En-tête Idempotency-Key trop long (100 caractères maximum).',
      400,
    );
  }

  return key.trim();
});
