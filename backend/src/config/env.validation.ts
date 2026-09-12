import * as Joi from 'joi';

/**
 * Validation des variables d'environnement.
 *
 * POURQUOI : si une variable manque ou est invalide, l'application refuse de
 * démarrer immédiatement, avec un message clair. C'est infiniment préférable à
 * une panne en pleine production, à 2h du matin, sur une transaction réelle.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  API_PREFIX: Joi.string().default('api'),
  CORS_ORIGINS: Joi.string().allow('').default(''),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),

  // En production, un secret court est un secret cassé.
  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_TTL: Joi.string().default('30d'),

  // --- Authentification (PHASE 3) ---
  OTP_LENGTH: Joi.number().integer().min(4).max(8).default(6),
  OTP_TTL_SECONDS: Joi.number().integer().min(60).max(900).default(300),
  OTP_MAX_ATTEMPTS: Joi.number().integer().min(1).max(10).default(3),
  OTP_RESEND_COOLDOWN_SECONDS: Joi.number().integer().min(0).default(60),
  OTP_MAX_PER_PHONE_PER_HOUR: Joi.number().integer().min(1).default(5),
  OTP_MAX_PER_IP_PER_HOUR: Joi.number().integer().min(1).default(20),

  // Renvoyer l'OTP dans la réponse HTTP permet de développer sans SMS.
  // La validation croisée plus bas l'INTERDIT en production.
  OTP_EXPOSE_IN_RESPONSE: Joi.boolean().default(false),

  PIN_LENGTH: Joi.number().integer().min(4).max(6).default(4),
  PIN_MAX_ATTEMPTS: Joi.number().integer().min(1).max(10).default(3),

  // --- Partenaires de paiement (PHASE 6) ---
  // Secret de signature des webhooks. Obligatoire et sans valeur par défaut :
  // un webhook non signé permettrait à n'importe qui de créditer un compte.
  MOCK_PROVIDER_WEBHOOK_SECRET: Joi.string().min(16).required(),

  DEFAULT_CURRENCY: Joi.string().length(3).uppercase().default('DJF'),
  CURRENCY_SCALE: Joi.number().integer().min(0).max(4).default(2),

  THROTTLE_TTL_MS: Joi.number().integer().default(60000),
  THROTTLE_LIMIT: Joi.number().integer().default(100),
}).custom((value, helpers) => {
  if (value.NODE_ENV === 'production' && value.JWT_ACCESS_SECRET === value.JWT_REFRESH_SECRET) {
    return helpers.error('any.invalid', {
      message: 'JWT_ACCESS_SECRET et JWT_REFRESH_SECRET doivent être différents',
    });
  }

  // Un OTP renvoyé dans la réponse HTTP rend la vérification par SMS inutile :
  // n'importe qui connaissant un numéro pourrait prendre la main sur le compte.
  // Cette erreur au démarrage est infiniment préférable à la découvrir en ligne.
  if (value.NODE_ENV === 'production' && value.OTP_EXPOSE_IN_RESPONSE === true) {
    return helpers.error('any.invalid', {
      message: 'OTP_EXPOSE_IN_RESPONSE doit valoir false en production',
    });
  }

  return value;
});
