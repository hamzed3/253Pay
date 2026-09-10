import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request } from 'express';

/** Champs à ne JAMAIS écrire dans les logs. */
const SENSITIVE_FIELDS = [
  'pin',
  'password',
  'otp',
  'code',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'authorization',
  'documentNumber',
];

export function maskSensitive(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(maskSensitive);
  if (input && typeof input === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      output[key] = SENSITIVE_FIELDS.includes(key) ? '***' : maskSensitive(value);
    }
    return output;
  }
  return input;
}

/**
 * Journalise chaque requête avec sa durée.
 * Ce qui n'est pas journalisé n'existe pas — mais un PIN journalisé est un PIN volé.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const { method, url } = request;
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.logger.log(`${method} ${url} → OK (${Date.now() - startedAt}ms)`),
        error: () => this.logger.warn(`${method} ${url} → ERREUR (${Date.now() - startedAt}ms)`),
      }),
    );
  }
}
