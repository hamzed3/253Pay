import { HashingService } from './hashing.service';

describe('HashingService', () => {
  const service = new HashingService();

  it('hache un jeton de façon déterministe', () => {
    // Contrairement à Argon2 : ici on a besoin de retrouver l'empreinte pour
    // faire une recherche indexée en base.
    const token = 'a'.repeat(128);
    expect(service.hashToken(token)).toBe(service.hashToken(token));
    expect(service.hashToken(token)).toHaveLength(64);
  });

  it('donne des empreintes différentes pour des jetons différents', () => {
    expect(service.hashToken('token-a')).not.toBe(service.hashToken('token-b'));
  });

  it('compare à temps constant', () => {
    expect(service.safeEquals('secret', 'secret')).toBe(true);
    expect(service.safeEquals('secret', 'secrez')).toBe(false);
    expect(service.safeEquals('secret', 'court')).toBe(false);
  });
});
