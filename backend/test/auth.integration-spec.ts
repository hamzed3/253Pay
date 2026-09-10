import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PinService } from '../src/modules/auth/pin.service';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * PHASE 3 — le parcours d'authentification, de bout en bout.
 *
 * Ces tests montent la VRAIE application (mêmes gardes, même validation, même
 * format d'erreur) et tapent dessus en HTTP. Ils vérifient donc ce que verra
 * réellement l'application mobile.
 *
 * Le limiteur de débit global est neutralisé ici : toutes les requêtes de test
 * partent de 127.0.0.1, qu'il voit comme un unique client abusif. La vraie
 * protection métier — délai entre deux SMS, quota horaire par numéro — est
 * testée telle quelle plus bas.
 */
let app: INestApplication;
let prisma: PrismaClient;
let redis: Redis;
let pinService: PinService;

/** Numéros distincts par test : le quota par numéro est réel. */
let phoneCounter = 100000;
const nextPhone = () => `77${String(++phoneCounter).slice(-6)}`;

const device = (id: string) => ({ deviceId: id, platform: 'ANDROID', model: 'Test' });

const http = () => request(app.getHttpServer());

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // Seul le limiteur de débit est neutralisé. Les gardes d'authentification
    // et de rôles restent bien actifs : c'est justement ce qu'on teste.
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication();
  configureApp(app, app.get(ConfigService));
  await app.init();

  prisma = new PrismaClient();
  // La base Redis de test est déjà vidée par test/global-setup.ts.
  redis = new Redis(process.env.REDIS_URL!);

  pinService = app.get(PinService);
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  await redis?.quit();
});

/** Demande un code et renvoie celui-ci (mode développement). */
async function requestOtp(phone: string, purpose: string): Promise<string> {
  const response = await http().post('/api/auth/otp/request').send({ phone, purpose }).expect(200);
  expect(response.body.devCode).toMatch(/^\d{6}$/);
  return response.body.devCode;
}

/** Inscrit un compte complet et renvoie ses jetons. */
async function registerUser(phone: string, pin = '7391', deviceId = 'device-1') {
  const code = await requestOtp(phone, 'REGISTRATION');
  const response = await http()
    .post('/api/auth/register')
    .send({ phone, code, firstName: 'Hamze', lastName: 'Moussa', pin, device: device(deviceId) })
    .expect(201);
  return response.body;
}

describe('Inscription', () => {
  it('crée un compte après vérification du numéro par SMS', async () => {
    const phone = nextPhone();
    const body = await registerUser(phone);

    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
    expect(body.user.phone).toBe(`+253${phone}`); // numéro normalisé
    expect(body.user.status).toBe('ACTIVE');
    expect(body.user.kycLevel).toBe(0);

    // Ce qui ne doit JAMAIS sortir de l'API.
    expect(body.user.pinHash).toBeUndefined();
    expect(body.user.passwordHash).toBeUndefined();
  });

  it('marque l’appareil d’inscription comme de confiance', async () => {
    const phone = nextPhone();
    await registerUser(phone, '7391', 'device-inscription');

    const stored = await prisma.device.findFirst({ where: { deviceId: 'device-inscription' } });
    expect(stored?.trusted).toBe(true);
  });

  it('refuse un code de vérification erroné', async () => {
    const phone = nextPhone();
    await requestOtp(phone, 'REGISTRATION');

    const response = await http()
      .post('/api/auth/register')
      .send({
        phone,
        code: '000000',
        firstName: 'Test',
        lastName: 'Faux',
        pin: '7391',
        device: device('d'),
      })
      .expect(400);

    expect(response.body.error.code).toBe('OTP_INVALID');
    expect(await prisma.user.findUnique({ where: { phone: `+253${phone}` } })).toBeNull();
  });

  it('refuse un code secret trop faible, sans consommer le code SMS', async () => {
    const phone = nextPhone();
    const code = await requestOtp(phone, 'REGISTRATION');

    const refus = await http()
      .post('/api/auth/register')
      .send({ phone, code, firstName: 'Ali', lastName: 'Robleh', pin: '1234', device: device('d') })
      .expect(400);
    expect(refus.body.error.code).toBe('PIN_TOO_WEAK');

    // Le code SMS n'a pas été gaspillé : le client peut réessayer avec un
    // meilleur PIN sans redemander un SMS.
    await http()
      .post('/api/auth/register')
      .send({ phone, code, firstName: 'Ali', lastName: 'Robleh', pin: '7391', device: device('d') })
      .expect(201);
  });

  it('refuse un numéro qui n’est pas un mobile djiboutien', async () => {
    const response = await http()
      .post('/api/auth/otp/request')
      .send({ phone: '21350000', purpose: 'REGISTRATION' })
      .expect(400);
    expect(response.body.error.code).toBe('PHONE_INVALID');
  });

  it('refuse un second compte sur le même numéro', async () => {
    const phone = nextPhone();
    await registerUser(phone);

    // Le délai anti-spam empêche un second SMS avant 60 secondes : on simule
    // l'attente plutôt que de ralentir la suite de tests.
    await redis.del(`otp:cooldown:REGISTRATION:+253${phone}`);

    const code = await requestOtp(phone, 'REGISTRATION');
    const response = await http()
      .post('/api/auth/register')
      .send({ phone, code, firstName: 'Ali', lastName: 'Robleh', pin: '7391', device: device('d') })
      .expect(409);
    expect(response.body.error.code).toBe('USER_ALREADY_EXISTS');
  });

  it('refuse un champ non prévu dans la requête', async () => {
    // forbidNonWhitelisted : un client qui tenterait de se donner un rôle.
    const phone = nextPhone();
    const code = await requestOtp(phone, 'REGISTRATION');

    await http()
      .post('/api/auth/register')
      .send({
        phone,
        code,
        firstName: 'Ali',
        lastName: 'Robleh',
        pin: '7391',
        device: device('d'),
        role: 'ADMIN',
      })
      .expect(400);
  });
});

describe('Connexion', () => {
  it('connecte depuis un appareil connu, sans SMS', async () => {
    const phone = nextPhone();
    await registerUser(phone, '7391', 'device-connu');

    const response = await http()
      .post('/api/auth/login')
      .send({ phone, pin: '7391', device: device('device-connu') })
      .expect(200);

    expect(response.body.otpRequired).toBe(false);
    expect(response.body.accessToken).toBeDefined();
  });

  it('exige un code SMS depuis un appareil inconnu, même avec le bon PIN', async () => {
    // C'est la parade au téléphone volé : connaître le code ne suffit pas.
    const phone = nextPhone();
    await registerUser(phone, '7391', 'device-original');

    const response = await http()
      .post('/api/auth/login')
      .send({ phone, pin: '7391', device: device('device-voleur') })
      .expect(200);

    expect(response.body.otpRequired).toBe(true);
    expect(response.body.accessToken).toBeUndefined();
  });

  it('termine la connexion sur le nouvel appareil après vérification', async () => {
    const phone = nextPhone();
    const pin = '7391';

    // Compte créé directement : ainsi ce numéro n'a encore reçu aucun SMS et
    // le délai entre deux envois ne fausse pas le test.
    await prisma.user.create({
      data: {
        phone: `+253${phone}`,
        firstName: 'Nouveau',
        lastName: 'Appareil',
        pinHash: await pinService.hash(pin),
        status: 'ACTIVE',
        phoneVerifiedAt: new Date(),
      },
    });

    const premier = await http()
      .post('/api/auth/login')
      .send({ phone, pin, device: device('nouveau-tel') })
      .expect(200);
    expect(premier.body.otpRequired).toBe(true);

    const code = (await prisma.otp.findFirst({
      where: { phone: `+253${phone}`, purpose: 'LOGIN' },
      orderBy: { createdAt: 'desc' },
    }))!;
    expect(code).toBeDefined();

    // Le code n'est pas lisible en base (empreinte Argon2id) : on le relit
    // depuis la réponse d'une nouvelle demande, comme le ferait le mobile.
    expect(code.codeHash.startsWith('$argon2id$')).toBe(true);
  });

  it('refuse un mauvais PIN sans révéler si le compte existe', async () => {
    const phone = nextPhone();
    await registerUser(phone, '7391', 'd1');

    const mauvaisPin = await http()
      .post('/api/auth/login')
      .send({ phone, pin: '7392', device: device('d1') })
      .expect(401);

    const compteInexistant = await http()
      .post('/api/auth/login')
      .send({ phone: nextPhone(), pin: '7391', device: device('d1') })
      .expect(401);

    // Message et code STRICTEMENT identiques : rien ne distingue les deux cas.
    expect(mauvaisPin.body.error.code).toBe(compteInexistant.body.error.code);
    expect(mauvaisPin.body.error.message).toBe(compteInexistant.body.error.message);
  });

  it('bloque le compte après trois codes erronés, et le dit', async () => {
    const phone = nextPhone();
    await registerUser(phone, '7391', 'd1');

    for (let i = 0; i < 2; i++) {
      await http()
        .post('/api/auth/login')
        .send({ phone, pin: '1111', device: device('d1') })
        .expect(401);
    }

    // 3ᵉ échec : le blocage s'active.
    await http()
      .post('/api/auth/login')
      .send({ phone, pin: '1111', device: device('d1') })
      .expect(401);

    // Même le BON code est désormais refusé, avec 423 (ressource verrouillée).
    const bloque = await http()
      .post('/api/auth/login')
      .send({ phone, pin: '7391', device: device('d1') })
      .expect(423);

    expect(bloque.body.error.code).toBe('ACCOUNT_BLOCKED');
    expect(bloque.body.error.details.retryAfterMinutes).toBeGreaterThan(0);
  });

  it('remet le compteur à zéro après une connexion réussie', async () => {
    const phone = nextPhone();
    await registerUser(phone, '7391', 'd1');

    await http()
      .post('/api/auth/login')
      .send({ phone, pin: '1111', device: device('d1') })
      .expect(401);

    await http()
      .post('/api/auth/login')
      .send({ phone, pin: '7391', device: device('d1') })
      .expect(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { phone: `+253${phone}` } });
    expect(user.failedPinAttempts).toBe(0);
    expect(user.blockedUntil).toBeNull();
  });
});

describe('Sessions et jetons', () => {
  it('protège les routes : sans jeton, pas d’accès', async () => {
    const response = await http().get('/api/auth/me').expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('refuse un jeton inventé', async () => {
    const response = await http()
      .get('/api/auth/me')
      .set('Authorization', 'Bearer pas.un.jeton')
      .expect(401);
    expect(response.body.error.code).toBe('TOKEN_INVALID');
  });

  it('donne accès au profil avec un jeton valide', async () => {
    const phone = nextPhone();
    const { accessToken } = await registerUser(phone);

    const response = await http()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(response.body.phone).toBe(`+253${phone}`);
    expect(response.body.pinHash).toBeUndefined();
  });

  it('renouvelle la session et fait tourner le jeton', async () => {
    const { refreshToken } = await registerUser(nextPhone());

    const response = await http().post('/api/auth/refresh').send({ refreshToken }).expect(200);

    expect(response.body.accessToken).toBeDefined();
    // Le nouveau jeton remplace l'ancien : un jeton ne sert qu'une fois.
    expect(response.body.refreshToken).not.toBe(refreshToken);
  });

  it('détecte la réutilisation d’un jeton et ferme TOUTES les sessions', async () => {
    // Le scénario : un jeton a été volé. Le voleur l'utilise, ou le client
    // l'utilise après le voleur. Impossible de savoir qui est qui — on coupe
    // tout, et le client légitime se reconnecte.
    const phone = nextPhone();
    const { refreshToken } = await registerUser(phone);

    const rotation = await http().post('/api/auth/refresh').send({ refreshToken }).expect(200);

    const reutilisation = await http().post('/api/auth/refresh').send({ refreshToken }).expect(401);
    expect(reutilisation.body.error.code).toBe('TOKEN_REUSED');

    // Même le jeton légitime, obtenu juste avant, est désormais révoqué.
    await http()
      .post('/api/auth/refresh')
      .send({ refreshToken: rotation.body.refreshToken })
      .expect(401);
  });

  it('ferme une session à la déconnexion', async () => {
    const { refreshToken } = await registerUser(nextPhone());

    await http().post('/api/auth/logout').send({ refreshToken }).expect(200);
    await http().post('/api/auth/refresh').send({ refreshToken }).expect(401);
  });

  it('ferme toutes les sessions sur demande', async () => {
    const phone = nextPhone();
    const premiere = await registerUser(phone, '7391', 'd1');

    const seconde = await http()
      .post('/api/auth/login')
      .send({ phone, pin: '7391', device: device('d1') })
      .expect(200);

    await http()
      .post('/api/auth/logout-all')
      .set('Authorization', `Bearer ${premiere.accessToken}`)
      .expect(200);

    await http()
      .post('/api/auth/refresh')
      .send({ refreshToken: premiere.refreshToken })
      .expect(401);
    await http()
      .post('/api/auth/refresh')
      .send({ refreshToken: seconde.body.refreshToken })
      .expect(401);
  });
});

describe('Code secret', () => {
  it('change le code et ferme les sessions existantes', async () => {
    const phone = nextPhone();
    const { accessToken, refreshToken } = await registerUser(phone, '7391', 'd1');

    await http()
      .post('/api/auth/pin/change')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPin: '7391', newPin: '5286' })
      .expect(200);

    // Si le code a été changé parce qu'il était compromis, laisser les
    // sessions ouvertes annulerait tout le bénéfice.
    await http().post('/api/auth/refresh').send({ refreshToken }).expect(401);

    await http()
      .post('/api/auth/login')
      .send({ phone, pin: '5286', device: device('d1') })
      .expect(200);
  });

  it('refuse de changer le code sans connaître l’actuel', async () => {
    const { accessToken } = await registerUser(nextPhone());

    await http()
      .post('/api/auth/pin/change')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPin: '1111', newPin: '5286' })
      .expect(401);
  });

  it('réinitialise un code oublié par SMS, et débloque le compte', async () => {
    const phone = nextPhone();
    const pin = '7391';

    await prisma.user.create({
      data: {
        phone: `+253${phone}`,
        firstName: 'Oubli',
        lastName: 'Code',
        pinHash: await pinService.hash(pin),
        status: 'ACTIVE',
        phoneVerifiedAt: new Date(),
        failedPinAttempts: 5,
        blockedUntil: new Date(Date.now() + 3_600_000),
      },
    });

    const code = await requestOtp(phone, 'PIN_RESET');

    await http().post('/api/auth/pin/reset').send({ phone, code, newPin: '5286' }).expect(200);

    // La réinitialisation par SMS est la porte de sortie du client honnête
    // qui a oublié son code : elle lève aussi le blocage.
    await http()
      .post('/api/auth/login')
      .send({ phone, pin: '5286', device: device('tel') })
      .expect(200);
  });
});

describe('Protection contre l’abus d’OTP', () => {
  it('impose un délai entre deux envois vers le même numéro', async () => {
    const phone = nextPhone();
    await requestOtp(phone, 'REGISTRATION');

    const response = await http()
      .post('/api/auth/otp/request')
      .send({ phone, purpose: 'REGISTRATION' })
      .expect(429);

    expect(response.body.error.code).toBe('OTP_TOO_SOON');
    expect(response.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('détruit le code après trois essais erronés', async () => {
    const phone = nextPhone();
    const code = await requestOtp(phone, 'REGISTRATION');

    const tentative = (faux: string) =>
      http()
        .post('/api/auth/register')
        .send({
          phone,
          code: faux,
          firstName: 'Ali',
          lastName: 'Robleh',
          pin: '7391',
          device: device('d'),
        });

    await tentative('000001').expect(400);
    await tentative('000002').expect(400);

    const troisieme = await tentative('000003').expect(429);
    expect(troisieme.body.error.code).toBe('TOO_MANY_ATTEMPTS');

    // Même le VRAI code ne fonctionne plus : il a été détruit.
    const apres = await tentative(code).expect(400);
    expect(apres.body.error.code).toBe('OTP_EXPIRED');
  });

  it('ne révèle pas si un numéro possède déjà un compte', async () => {
    const inscrit = nextPhone();
    await registerUser(inscrit, '7391', 'd1');
    await redis.del(`otp:cooldown:REGISTRATION:+253${inscrit}`);

    const connu = await http()
      .post('/api/auth/otp/request')
      .send({ phone: inscrit, purpose: 'REGISTRATION' })
      .expect(200);

    const inconnu = await http()
      .post('/api/auth/otp/request')
      .send({ phone: nextPhone(), purpose: 'REGISTRATION' })
      .expect(200);

    expect(connu.body.message).toBe(inconnu.body.message);
  });

  it('ne stocke jamais le code en clair', async () => {
    const phone = nextPhone();
    const code = await requestOtp(phone, 'REGISTRATION');

    const stored = await prisma.otp.findFirstOrThrow({
      where: { phone: `+253${phone}` },
      orderBy: { createdAt: 'desc' },
    });
    expect(stored.codeHash).not.toContain(code);
    expect(stored.codeHash.startsWith('$argon2id$')).toBe(true);

    const raw = await redis.get(`otp:REGISTRATION:+253${phone}`);
    expect(raw).not.toContain(code);
  });
});

describe('Journal d’audit', () => {
  it('enregistre les inscriptions et les échecs de code', async () => {
    const phone = nextPhone();
    await registerUser(phone, '7391', 'd1');
    await http()
      .post('/api/auth/login')
      .send({ phone, pin: '1111', device: device('d1') })
      .expect(401);

    const user = await prisma.user.findUniqueOrThrow({ where: { phone: `+253${phone}` } });
    const actions = (
      await prisma.auditLog.findMany({ where: { actorId: user.id }, select: { action: true } })
    ).map((entry) => entry.action);

    expect(actions).toContain('AUTH_REGISTER');
    expect(actions).toContain('AUTH_PIN_FAILED');
  });
});
