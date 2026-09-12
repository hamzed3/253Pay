import { ConfigService } from '@nestjs/config';
import { PinService } from './pin.service';
import { HashingService } from '../../common/hashing/hashing.service';
import { BusinessError } from '../../common/errors/error-codes';

describe('PinService', () => {
  const config = {
    get: (key: string, fallback: unknown) =>
      ({ 'auth.pin.length': 4, 'auth.pin.maxAttempts': 3 })[key] ?? fallback,
  } as unknown as ConfigService;

  const service = new PinService(new HashingService(), config);

  describe('refuse les codes devinables', () => {
    it.each(['1234', '0000', '1111', '4321', '2580', '1212'])('refuse « %s »', (pin) => {
      expect(() => service.assertStrongEnough(pin)).toThrow(BusinessError);
    });

    it('refuse une suite croissante ou décroissante', () => {
      expect(() => service.assertStrongEnough('5678')).toThrow(BusinessError);
      expect(() => service.assertStrongEnough('9876')).toThrow(BusinessError);
    });

    it('refuse un code contenu dans le propre numéro du client', () => {
      // Le premier essai d'un proche, et le plus efficace.
      expect(() => service.assertStrongEnough('1234', '+25377123456')).toThrow(BusinessError);
    });

    it('refuse ce qui n’est pas 4 chiffres', () => {
      expect(() => service.assertStrongEnough('123')).toThrow(BusinessError);
      expect(() => service.assertStrongEnough('abcd')).toThrow(BusinessError);
    });
  });

  it('accepte un code correct', () => {
    expect(() => service.assertStrongEnough('7391', '+25377000000')).not.toThrow();
  });

  describe('blocage progressif', () => {
    it('ne bloque pas avant le nombre maximal de tentatives', () => {
      expect(service.nextLockState(0).blockedUntil).toBeNull();
      expect(service.nextLockState(1).blockedUntil).toBeNull();
    });

    it('bloque 5 minutes au 3ᵉ échec', () => {
      const state = service.nextLockState(2);
      expect(state.failedAttempts).toBe(3);
      expect(service.remainingLockMinutes(state.blockedUntil!)).toBe(5);
    });

    it('allonge le blocage à chaque nouvel échec', () => {
      // 4ᵉ échec : 15 min, 5ᵉ : 60 min, 6ᵉ : 24 h.
      expect(service.remainingLockMinutes(service.nextLockState(3).blockedUntil!)).toBe(15);
      expect(service.remainingLockMinutes(service.nextLockState(4).blockedUntil!)).toBe(60);
      expect(service.remainingLockMinutes(service.nextLockState(5).blockedUntil!)).toBe(24 * 60);
    });

    it('plafonne au dernier palier plutôt que de dépasser le tableau', () => {
      expect(service.remainingLockMinutes(service.nextLockState(50).blockedUntil!)).toBe(24 * 60);
    });
  });

  describe('hachage', () => {
    it('produit une empreinte Argon2id vérifiable', async () => {
      const hash = await service.hash('7391');
      expect(hash.startsWith('$argon2id$')).toBe(true);
      expect(await service.verify(hash, '7391')).toBe(true);
      expect(await service.verify(hash, '7392')).toBe(false);
    });

    it('donne deux empreintes différentes pour le même code', async () => {
      // Le sel aléatoire : deux clients avec le même PIN n'ont pas la même
      // empreinte, donc une table pré-calculée ne sert à rien.
      const a = await service.hash('7391');
      const b = await service.hash('7391');
      expect(a).not.toBe(b);
    });

    it('renvoie false sur une empreinte corrompue, sans lever', async () => {
      expect(await service.verify('pas-une-empreinte', '7391')).toBe(false);
    });
  });
});
