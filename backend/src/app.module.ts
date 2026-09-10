import { join } from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { JwtModule } from '@nestjs/jwt';
import { appConfig } from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { PrismaModule } from './database/prisma.module';
import { RedisModule } from './database/redis.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { AuditModule } from './modules/audit/audit.module';
import { HashingModule } from './common/hashing/hashing.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';

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
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.get<number>('THROTTLE_TTL_MS', 60000),
            limit: config.get<number>('THROTTLE_LIMIT', 100),
          },
        ],

        // Neutralisé UNIQUEMENT pendant les tests automatisés.
        //
        // POURQUOI : toutes les requêtes de test partent de 127.0.0.1. Le
        // limiteur y voit un unique client très bavard et bloque le scénario
        // dès la 6ᵉ requête, alors que rien d'anormal ne se passe.
        //
        // Le garde-fou est le test d'égalité avec 'test' : Joi n'accepte que
        // development, test ou production pour NODE_ENV, donc cette condition
        // ne peut jamais être vraie en production.
        //
        // La vraie protection métier — délai entre deux SMS, quota horaire par
        // numéro — n'est PAS désactivée et reste testée telle quelle.
        skipIf: () => config.get<string>('env') === 'test',
      }),
    }),

    PrismaModule,
    RedisModule,
    HashingModule,
    AuditModule,

    // JwtModule global : le JwtAuthGuard en a besoin pour vérifier les jetons.
    JwtModule.register({}),

    HealthModule,
    UsersModule,
    AuthModule,
    // PHASE 4 : WalletsModule, LedgerModule
  ],

  // L'ORDRE COMPTE : les gardes s'exécutent dans l'ordre de déclaration.
  //
  // 1. Throttler : on refuse le trop-plein avant de travailler. Une attaque
  //    par force brute ne doit pas déclencher un calcul Argon2 à chaque essai.
  // 2. JwtAuthGuard : identifie l'utilisateur et recharge son statut réel.
  // 3. RolesGuard : décide des droits, à partir de cet utilisateur rechargé.
  //
  // Les deux derniers sont GLOBAUX : toute route est fermée par défaut, et
  // s'ouvre explicitement avec @Public(). Une route oubliée reste protégée.
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
