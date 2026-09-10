import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

/**
 * Configuration de l'application, en un seul endroit.
 *
 * POURQUOI ce fichier existe : sécurité, validation et format d'erreur étaient
 * réglés directement dans main.ts. Les tests, qui construisent l'application
 * autrement, ne les voyaient donc pas — ils validaient un pipeline qui n'est
 * pas celui qui tourne en production. Un test qui passe sur une configuration
 * différente de la vraie ne prouve rien.
 *
 * Désormais main.ts et les tests appellent la même fonction.
 */
export function configureApp(app: INestApplication, config: ConfigService): string {
  // En-têtes HTTP de sécurité (XSS, clickjacking, sniffing).
  app.use(helmet());

  const corsOrigins = config.get<string[]>('corsOrigins') ?? [];
  app.enableCors({ origin: corsOrigins.length ? corsOrigins : true, credentials: true });

  // Toutes les routes sont préfixées par /api, sauf /health.
  const apiPrefix = config.get<string>('apiPrefix', 'api');
  app.setGlobalPrefix(apiPrefix, { exclude: ['health'] });

  // Validation stricte de toute entrée.
  // forbidNonWhitelisted : un champ inconnu fait échouer la requête. Sur une
  // API financière, un champ non prévu est presque toujours une tentative
  // d'abus — un `role` ou un `kycLevel` que le client n'a pas à décider.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  return apiPrefix;
}

/** Documentation d'API — jamais exposée en production. */
export function setupSwagger(app: INestApplication, apiPrefix: string): void {
  const swaggerConfig = new DocumentBuilder()
    .setTitle('253Pay API')
    .setDescription('Plateforme de paiement numérique — Djibouti')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();

  SwaggerModule.setup(`${apiPrefix}/docs`, app, SwaggerModule.createDocument(app, swaggerConfig));
}
