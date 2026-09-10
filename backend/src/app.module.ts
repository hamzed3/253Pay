import { join } from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { appConfig } from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { PrismaModule } from './database/prisma.module';
import { RedisModule } from './database/redis.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,

      // Le fichier .env vit à la RACINE du dépôt, pas dans backend/ : il est
      // partagé avec docker-compose.yml (mêmes identifiants PostgreSQL).
      // Nest cherche par défaut dans le dossier courant, d'où ce chemin explicite.
      // Un backend/.env, s'il existe, reste prioritaire (utile en CI).
      envFilePath: [join(process.cwd(), '.env'), join(process.cwd(), '..', '.env')],

      load: [appConfig],
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),

    // Limitation de débit globale. Sur une API financière, c'est la première
    // barrière contre la force brute sur le PIN et l'abus d'envoi d'OTP.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: config.get<number>('THROTTLE_TTL_MS', 60000),
          limit: config.get<number>('THROTTLE_LIMIT', 100),
        },
      ],
    }),

    PrismaModule,
    RedisModule,
    HealthModule,
    // PHASE 3 : AuthModule
    // PHASE 4 : WalletsModule, LedgerModule
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
