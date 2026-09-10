/**
 * Accès typé à la configuration.
 * On ne lit jamais process.env directement ailleurs dans le code.
 */
export const appConfig = () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  apiPrefix: process.env.API_PREFIX ?? 'api',
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  isProduction: process.env.NODE_ENV === 'production',
  money: {
    currency: process.env.DEFAULT_CURRENCY ?? 'DJF',
    scale: parseInt(process.env.CURRENCY_SCALE ?? '2', 10),
  },
  throttle: {
    ttl: parseInt(process.env.THROTTLE_TTL_MS ?? '60000', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
  },
});
