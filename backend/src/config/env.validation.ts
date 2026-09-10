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
  return value;
});
