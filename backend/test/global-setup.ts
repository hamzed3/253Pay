import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

/**
 * Prépare une base JETABLE pour les tests d'intégration.
 *
 * POURQUOI une base à part : ces tests écrivent des transactions et des
 * écritures comptables. Or le ledger est immuable — impossible de faire le
 * ménage après coup, c'est justement ce qu'on vérifie. On repart donc d'une
 * base vide à chaque exécution, et on ne touche jamais à la base de
 * développement.
 *
 * GARDE-FOU : ce script refuse de supprimer une base dont le nom ne se
 * termine pas par « _test ». Une variable d'environnement mal réglée ne peut
 * pas effacer une base réelle.
 */
export default async function globalSetup(): Promise<void> {
  loadEnv({ path: join(__dirname, '..', '..', '.env') });

  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error(
      'DATABASE_URL est introuvable. Avez-vous créé le fichier .env à la racine du dépôt ?',
    );
  }

  const testUrl = new URL(baseUrl);
  const testDbName = `${testUrl.pathname.replace(/^\//, '')}_test`;

  if (!testDbName.endsWith('_test')) {
    throw new Error(`Refus de manipuler la base « ${testDbName} » : nom non suffixé par _test.`);
  }

  testUrl.pathname = `/${testDbName}`;

  // Connexion à la base de maintenance pour recréer la base de test.
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';

  const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${testDbName}"`);
  } finally {
    await admin.$disconnect();
  }

  // Les migrations sont rejouées : on teste le schéma réel, déclencheurs
  // et contraintes compris, pas une approximation.
  const childEnv = { ...process.env, DATABASE_URL: testUrl.toString() };

  execSync('npx prisma migrate deploy', {
    cwd: join(__dirname, '..'),
    env: childEnv,
    stdio: 'pipe',
  });

  // Le plan comptable système est une donnée de référence, pas un jeu d'essai :
  // sans SYSTEM_REVENUE, aucune écriture de frais n'est possible.
  execSync('npx prisma db seed', {
    cwd: join(__dirname, '..'),
    env: childEnv,
    stdio: 'pipe',
  });

  // Hérité par les processus de test.
  process.env.DATABASE_URL = testUrl.toString();
  process.env.TEST_DATABASE_URL = testUrl.toString();

  // Redis : on bascule sur la base 1, jamais la 0 utilisée en développement.
  // Un test qui viderait les OTP en cours d'un développeur serait pénible.
  const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6380');
  redisUrl.pathname = '/1';
  process.env.REDIS_URL = redisUrl.toString();

  // ...et on la VIDE, exactement comme la base PostgreSQL est recréée.
  //
  // Sans cela, les délais anti-spam et les compteurs de quota survivaient d'une
  // exécution à l'autre : un test réutilisant un numéro moins de 60 secondes
  // après le précédent recevait un 429 et échouait sans raison apparente.
  // Une suite de tests instable sur un ledger est pire qu'une suite absente :
  // on finit par ignorer ses échecs.
  const redis = new Redis(redisUrl.toString());
  try {
    await redis.flushdb();
  } finally {
    await redis.quit();
  }

  // Toutes les requêtes de test partent de 127.0.0.1. Les quotas PAR IP
  // verraient donc un seul client très bavard : on les relâche, sans toucher
  // aux quotas PAR NUMÉRO, qui sont la vraie protection métier et restent
  // testés tels quels.
  process.env.OTP_MAX_PER_IP_PER_HOUR = '10000';

  // L'OTP doit être lisible dans la réponse pour que les tests puissent
  // enchaîner. C'est le mode de développement, interdit en production.
  process.env.OTP_EXPOSE_IN_RESPONSE = 'true';

  // Signale à l'application qu'elle tourne en test : voir le `skipIf` du
  // limiteur de débit dans app.module.ts.
  process.env.NODE_ENV = 'test';
}
