import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { BusinessError, ErrorCode } from '../errors/error-codes';

/**
 * Filtre global d'erreurs.
 *
 * POURQUOI : une erreur brute peut révéler la structure de la base, une requête
 * SQL, un chemin de fichier. Le client reçoit donc un format unique et neutre ;
 * les détails partent uniquement dans les logs serveur, avec un identifiant de
 * corrélation que le support peut demander à l'utilisateur.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const traceId = randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: string = ErrorCode.INTERNAL_ERROR;
    let message = 'Une erreur est survenue. Veuillez réessayer.';
    let details: unknown;

    if (exception instanceof BusinessError) {
      status = exception.httpStatus;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        const record = body as Record<string, unknown>;
        message = (record.message as string) ?? exception.message;
        // Une HttpException que NOUS construisons (ex. /health) transporte un
        // corps utile mais sans champ "message". Sans cela, le client ne
        // recevait que « Service Unavailable Exception » et perdait le détail
        // de la dépendance en panne. Ce corps vient de notre code, pas d'une
        // erreur brute : il est sans danger à renvoyer.
        details = record.errors ?? (record.message === undefined ? record : undefined);
      } else {
        message = String(body);
      }
      if (status === HttpStatus.BAD_REQUEST) code = ErrorCode.VALIDATION_FAILED;
      if (status === HttpStatus.NOT_FOUND) code = ErrorCode.NOT_FOUND;
      if (status === HttpStatus.TOO_MANY_REQUESTS) code = ErrorCode.RATE_LIMITED;
    }

    const logPayload = {
      traceId,
      method: request.method,
      path: request.url,
      status,
      code,
    };

    if (status >= 500) {
      this.logger.error(JSON.stringify(logPayload), (exception as Error)?.stack);
    } else {
      this.logger.warn(JSON.stringify({ ...logPayload, message }));
    }

    response.status(status).json({
      success: false,
      error: { code, message, details },
      traceId,
      timestamp: new Date().toISOString(),
    });
  }
}
