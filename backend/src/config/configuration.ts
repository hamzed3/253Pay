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
  auth: {
    otp: {
      length: parseInt(process.env.OTP_LENGTH ?? '6', 10),
      ttlSeconds: parseInt(process.env.OTP_TTL_SECONDS ?? '300', 10),
      maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS ?? '3', 10),
      resendCooldownSeconds: parseInt(process.env.OTP_RESEND_COOLDOWN_SECONDS ?? '60', 10),
      maxPerPhonePerHour: parseInt(process.env.OTP_MAX_PER_PHONE_PER_HOUR ?? '5', 10),
      maxPerIpPerHour: parseInt(process.env.OTP_MAX_PER_IP_PER_HOUR ?? '20', 10),
      exposeInResponse: process.env.OTP_EXPOSE_IN_RESPONSE === 'true',
    },
    pin: {
      length: parseInt(process.env.PIN_LENGTH ?? '4', 10),
      maxAttempts: parseInt(process.env.PIN_MAX_ATTEMPTS ?? '3', 10),
    },
  },
  throttle: {
    ttl: parseInt(process.env.THROTTLE_TTL_MS ?? '60000', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
  },
});
