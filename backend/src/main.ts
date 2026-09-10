import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // En-têtes HTTP de sécurité (XSS, clickjacking, sniffing).
  app.use(helmet());

  const corsOrigins = config.get<string[]>('corsOrigins') ?? [];
  app.enableCors({ origin: corsOrigins.length ? corsOrigins : true, credentials: true });

  // Toutes les routes sont préfixées par /api, sauf /health.
  const apiPrefix = config.get<string>('apiPrefix', 'api');
  app.setGlobalPrefix(apiPrefix, { exclude: ['health'] });

  // Validation stricte de toute entrée.
  // forbidNonWhitelisted : un champ inconnu fait échouer la requête. Sur une API
  // financière, un champ non prévu est presque toujours une tentative d'abus.
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

  // Documentation d'API — jamais exposée en production.
  if (!config.get<boolean>('isProduction')) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('253Pay API')
      .setDescription('Plateforme de paiement numérique — Djibouti')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(`${apiPrefix}/docs`, app, document);
  }

  // Permet à Nest de fermer proprement les connexions PostgreSQL et Redis.
  app.enableShutdownHooks();

  const port = config.get<number>('port', 3000);
  await app.listen(port, '0.0.0.0');

  logger.log(`253Pay API démarrée sur http://localhost:${port}`);
  logger.log(`Santé        : http://localhost:${port}/health`);
  logger.log(`Documentation : http://localhost:${port}/${apiPrefix}/docs`);
}

void bootstrap();
