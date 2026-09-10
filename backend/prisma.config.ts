import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Le CLI Prisma cherche .env dans backend/. Or le nôtre vit à la RACINE du
// dépôt, partagé avec docker-compose.yml (mêmes identifiants PostgreSQL).
// Sans ce chargement explicite, prisma migrate échoue sur
// « Environment variable not found: DATABASE_URL ».
loadEnv({ path: join(__dirname, '..', '.env') });
loadEnv({ path: join(__dirname, '.env'), override: true }); // surcharge locale éventuelle (CI)

export default defineConfig({
  schema: join('prisma', 'schema.prisma'),
  migrations: {
    seed: 'ts-node prisma/seed.ts',
  },
});
