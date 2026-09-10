import {
  assertBalanced,
  balanceDelta,
  computeBalance,
  lockOrder,
  naturalSide,
} from './ledger.rules';
import { BusinessError } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';

const fdj = (major: number) => Money.fromMajor(major).minor;

describe('Sens naturel des comptes', () => {
  it('un actif et une dépense augmentent au débit', () => {
    expect(naturalSide('ASSET')).toBe('DEBIT');
    expect(naturalSide('EXPENSE')).toBe('DEBIT');
  });

  it('une dette, un produit et les fonds propres augmentent au crédit', () => {
    expect(naturalSide('LIABILITY')).toBe('CREDIT');
    expect(naturalSide('REVENUE')).toBe('CREDIT');
    expect(naturalSide('EQUITY')).toBe('CREDIT');
  });
});

describe('Solde d’un compte', () => {
  it('un portefeuille client crédité de 5 000 a bien 5 000', () => {
    // L'erreur classique serait d'appliquer « débit moins crédit » partout :
    // ce client afficherait -5 000 FDJ alors qu'il vient d'être payé.
    const solde = computeBalance('LIABILITY', { debitMinor: 0n, creditMinor: fdj(5000) });
    expect(Money.fromMinor(solde).format()).toBe('5 000 FDJ');
  });

  it('un portefeuille qui envoie 5 050 sur 8 000 garde 2 950', () => {
    const solde = computeBalance('LIABILITY', {
      debitMinor: fdj(5050),
      creditMinor: fdj(8000),
    });
    expect(Money.fromMinor(solde).format()).toBe('2 950 FDJ');
  });

  it('la trésorerie, elle, augmente au débit', () => {
    const solde = computeBalance('ASSET', { debitMinor: fdj(10000), creditMinor: 0n });
    expect(Money.fromMinor(solde).format()).toBe('10 000 FDJ');
  });

  it('un compte vide vaut zéro', () => {
    expect(computeBalance('LIABILITY', { debitMinor: 0n, creditMinor: 0n })).toBe(0n);
  });
});

describe('Effet d’une écriture', () => {
  it('crédite un portefeuille : son solde monte', () => {
    expect(balanceDelta('LIABILITY', 'CREDIT', fdj(100))).toBe(fdj(100));
  });

  it('débite un portefeuille : son solde baisse', () => {
    expect(balanceDelta('LIABILITY', 'DEBIT', fdj(100))).toBe(-fdj(100));
  });

  it('débite la trésorerie : elle monte', () => {
    expect(balanceDelta('ASSET', 'DEBIT', fdj(100))).toBe(fdj(100));
  });
});

describe('Équilibre des écritures', () => {
  const leg = (direction: 'DEBIT' | 'CREDIT', montant: number) => ({
    accountId: `compte-${direction}-${montant}`,
    direction,
    amountMinor: fdj(montant),
  });

  it('accepte un transfert avec frais, correctement équilibré', () => {
    // 5 050 sortent du payeur ; 5 000 arrivent au bénéficiaire, 50 en produits.
    expect(() =>
      assertBalanced([leg('DEBIT', 5050), leg('CREDIT', 5000), leg('CREDIT', 50)]),
    ).not.toThrow();
  });

  it('refuse un déséquilibre, même d’un franc', () => {
    // Le bug du moteur de frais : 1 FDJ se volatiliserait à chaque opération.
    expect(() => assertBalanced([leg('DEBIT', 5050), leg('CREDIT', 5049)])).toThrow(BusinessError);
  });

  it('refuse une écriture seule', () => {
    expect(() => assertBalanced([leg('DEBIT', 100)])).toThrow(BusinessError);
  });

  it('refuse un montant nul ou négatif', () => {
    expect(() =>
      assertBalanced([
        { accountId: 'a', direction: 'DEBIT', amountMinor: 0n },
        { accountId: 'b', direction: 'CREDIT', amountMinor: 0n },
      ]),
    ).toThrow(BusinessError);
  });

  it('donne le détail des totaux dans l’erreur', () => {
    try {
      assertBalanced([leg('DEBIT', 100), leg('CREDIT', 90)]);
      fail('aurait dû lever');
    } catch (error) {
      expect((error as BusinessError).details).toEqual({
        debitMinor: '10000',
        creditMinor: '9000',
      });
    }
  });
});

describe('Ordre de verrouillage', () => {
  it('trie par UUID croissant et supprime les doublons', () => {
    expect(lockOrder(['c', 'a', 'b', 'a'])).toEqual(['a', 'b', 'c']);
  });

  it('donne le MÊME ordre quel que soit le sens du transfert', () => {
    // C'est tout l'intérêt : A→B et B→A verrouillent dans le même ordre,
    // donc ne peuvent pas s'interbloquer.
    const aVersB = lockOrder(['wallet-b', 'wallet-a']);
    const bVersA = lockOrder(['wallet-a', 'wallet-b']);
    expect(aVersB).toEqual(bVersA);
  });
});
