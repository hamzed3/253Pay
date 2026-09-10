/**
 * Codes d'erreur métier de 253Pay.
 *
 * POURQUOI des codes et pas seulement des messages :
 *  - l'application mobile peut traduire (fr / so / ar / en) ;
 *  - le support client peut identifier un problème sans lire les logs ;
 *  - le message affiché peut changer sans casser le code.
 */
export enum ErrorCode {
  // Générique
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  RATE_LIMITED = 'RATE_LIMITED',
  NOT_FOUND = 'NOT_FOUND',

  // Authentification (phase 3)
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  FORBIDDEN = 'FORBIDDEN',
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  PHONE_INVALID = 'PHONE_INVALID',
  PIN_TOO_WEAK = 'PIN_TOO_WEAK',
  USER_ALREADY_EXISTS = 'USER_ALREADY_EXISTS',
  OTP_INVALID = 'OTP_INVALID',
  OTP_EXPIRED = 'OTP_EXPIRED',
  OTP_REQUIRED = 'OTP_REQUIRED',
  OTP_TOO_SOON = 'OTP_TOO_SOON',
  TOKEN_INVALID = 'TOKEN_INVALID',
  TOKEN_REUSED = 'TOKEN_REUSED',
  TOO_MANY_ATTEMPTS = 'TOO_MANY_ATTEMPTS',
  ACCOUNT_BLOCKED = 'ACCOUNT_BLOCKED',
  ACCOUNT_NOT_ACTIVE = 'ACCOUNT_NOT_ACTIVE',

  // Transferts (phase 5)
  RECIPIENT_NOT_FOUND = 'RECIPIENT_NOT_FOUND',
  SELF_TRANSFER_FORBIDDEN = 'SELF_TRANSFER_FORBIDDEN',
  TRANSACTION_NOT_REVERSIBLE = 'TRANSACTION_NOT_REVERSIBLE',

  // Argent (phases 4 à 8)
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  WALLET_NOT_FOUND = 'WALLET_NOT_FOUND',
  LIMIT_EXCEEDED = 'LIMIT_EXCEEDED',
  KYC_REQUIRED = 'KYC_REQUIRED',
  CURRENCY_MISMATCH = 'CURRENCY_MISMATCH',
  DUPLICATE_REQUEST = 'DUPLICATE_REQUEST',
  LEDGER_UNBALANCED = 'LEDGER_UNBALANCED',
}

export class BusinessError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly httpStatus = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BusinessError';
  }
}
