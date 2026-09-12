import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp, setupSwagger } from './bootstrap';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  // rawBody : conserve le corps brut des requêtes, indispensable pour vérifier
  // la signature des webhooks. Re-sérialiser du JSON ne redonne pas les mêmes
  // octets, et la signature ne correspondrait plus.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(ConfigService);

  const apiPrefix = configureApp(app, config);

  if (!config.get<boolean>('isProduction')) {
    setupSwagger(app, apiPrefix);
  }

  // Permet à Nest de fermer proprement les connexions PostgreSQL et Redis.
  app.enableShutdownHooks();

  const port = config.get<number>('port', 3000);
  await app.listen(port, '0.0.0.0');

  logger.log(`253Pay API démarrée sur http://localhost:${port}`);
  logger.log(`Santé         : http://localhost:${port}/health`);
  logger.log(`Documentation : http://localhost:${port}/${apiPrefix}/docs`);
}

void bootstrap();
