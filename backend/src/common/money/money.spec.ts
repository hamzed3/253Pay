import { Money } from './money';
import { BusinessError } from '../errors/error-codes';

describe('Money', () => {
  it('convertit une unité majeure en unité mineure', () => {
    expect(Money.fromMajor(1000).minor).toBe(100000n);
    expect(Money.fromMajor('0.5').minor).toBe(50n);
  });

  it("n'a aucune erreur d'arrondi, contrairement aux nombres flottants", () => {
    // En JavaScript : 0.1 + 0.2 !== 0.3
    const total = Money.fromMajor('0.1').add(Money.fromMajor('0.2'));
    expect(total.equals(Money.fromMajor('0.3'))).toBe(true);
  });

  it('additionne et soustrait', () => {
    const a = Money.fromMajor(5000);
    const b = Money.fromMajor(50);
    expect(a.add(b).format()).toBe('5 050 FDJ');
    expect(a.subtract(b).format()).toBe('4 950 FDJ');
  });

  it('refuse de mélanger deux devises', () => {
    const fdj = Money.fromMajor(100, 'DJF');
    const usd = Money.fromMajor(100, 'USD');
    expect(() => fdj.add(usd)).toThrow(BusinessError);
  });

  it('calcule un taux en points de base', () => {
    // 1 % de 10 000 FDJ = 100 FDJ
    expect(Money.fromMajor(10000).applyRate(100).format()).toBe('100 FDJ');
    // 1,5 % de 10 000 FDJ = 150 FDJ
    expect(Money.fromMajor(10000).applyRate(150).format()).toBe('150 FDJ');
  });

  it('arrondit au demi supérieur', () => {
    // 1 % de 33 FDJ = 0,33 FDJ -> 33 unités mineures
    expect(Money.fromMajor(33).applyRate(100).minor).toBe(33n);
  });

  it('rejette un montant mal formé', () => {
    expect(() => Money.fromMajor('abc')).toThrow(BusinessError);
    expect(() => Money.fromMajor('1.999')).toThrow(BusinessError);
  });

  it('formate avec des séparateurs de milliers', () => {
    expect(Money.fromMajor(1234567).format()).toBe('1 234 567 FDJ');
  });

  it('détecte un solde négatif', () => {
    expect(Money.fromMajor(100).subtract(Money.fromMajor(200)).isNegative()).toBe(true);
  });
});
