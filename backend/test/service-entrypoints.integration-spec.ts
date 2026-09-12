import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';

/**
 * Les deux portes d'entrée du service, sans authentification.
 *
 * Ce fichier existe à cause d'un vrai incident : la racine `/` renvoyait un
 * 404 nu, et personne ouvrant l'adresse du service dans un navigateur ne
 * pouvait savoir ce qu'il avait atteint.
 *
 * Le préfixe global `/api` est la cause à surveiller : toute route en est
 * préfixée, sauf exclusion explicite. Une modification distraite de cette
 * liste referait disparaître la racine — d'où ces tests.
 */
let app: INestApplication;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication();
  configureApp(app, app.get(ConfigService));
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

describe('Racine du service', () => {
  it('répond sur / et s’identifie, sans authentification', async () => {
    const response = await http().get('/').expect(200);

    expect(response.body.service).toBe('253Pay API');
    expect(response.body.status).toBe('ok');
    expect(response.body.endpoints.health).toBe('/health');
  });

  it('n’est PAS préfixée par /api', async () => {
    // Le piège : sans exclusion du préfixe global, le contrôleur racine se
    // monte sur /api et la racine du domaine reste en 404.
    await http().get('/api').expect(404);
  });

  it('ne divulgue rien de sensible', async () => {
    const response = await http().get('/').expect(200);
    const corps = JSON.stringify(response.body).toLowerCase();

    for (const interdit of ['secret', 'password', 'token', 'database_url', 'postgres']) {
      expect(corps).not.toContain(interdit);
    }
  });
});

describe('Le reste du routage est intact', () => {
  it('/health vérifie toujours ses dépendances', async () => {
    const response = await http().get('/health').expect(200);
    expect(response.body.db).toBe('up');
    expect(response.body.redis).toBe('up');
  });

  it('une route inconnue renvoie le format d’erreur du projet', async () => {
    // Un 404 de 253Pay porte un traceId. Celui d'un hébergeur, non : c'est
    // ainsi qu'on distingue « l'API a répondu » de « rien n'a répondu ».
    const response = await http().get('/nimporte-quoi').expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.traceId).toBeDefined();
  });

  it('les routes métier restent protégées', async () => {
    await http().get('/api/auth/me').expect(401);
    await http().get('/api/wallets/me').expect(401);
  });
});
