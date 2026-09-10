import { normalizePhone, maskPhone } from './phone';
import { BusinessError } from '../errors/error-codes';

describe('normalizePhone', () => {
  it('accepte les écritures habituelles du même numéro', () => {
    // Le point de tout ce fichier : ces cinq saisies désignent UNE personne.
    // Sans normalisation, elles créeraient cinq comptes.
    const attendu = '+25377123456';
    expect(normalizePhone('77123456')).toBe(attendu);
    expect(normalizePhone('77 12 34 56')).toBe(attendu);
    expect(normalizePhone('+253 77 12 34 56')).toBe(attendu);
    expect(normalizePhone('25377123456')).toBe(attendu);
    expect(normalizePhone('0025377123456')).toBe(attendu);
  });

  it('accepte un zéro initial, saisi par habitude', () => {
    expect(normalizePhone('077123456')).toBe('+25377123456');
  });

  it('accepte les tirets et les parenthèses', () => {
    expect(normalizePhone('(77) 12-34-56')).toBe('+25377123456');
  });

  it('refuse une ligne fixe : elle ne reçoit pas de SMS', () => {
    expect(() => normalizePhone('21350000')).toThrow(BusinessError);
  });

  it('refuse un numéro trop court ou trop long', () => {
    expect(() => normalizePhone('7712345')).toThrow(BusinessError);
    expect(() => normalizePhone('771234567')).toThrow(BusinessError);
  });

  it('refuse ce qui n’est pas un numéro', () => {
    expect(() => normalizePhone('abcdefgh')).toThrow(BusinessError);
    expect(() => normalizePhone('')).toThrow(BusinessError);
  });
});

describe('maskPhone', () => {
  it('masque le milieu du numéro', () => {
    expect(maskPhone('+25377123456')).toBe('+253 77 ** ** 56');
  });
});
