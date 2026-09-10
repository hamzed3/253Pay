import { FeeRule } from '@prisma/client';
import { computeFee, selectRule } from './fees.rules';
import { Money } from '../../common/money/money';

const fdj = (major: number) => Money.fromMajor(major).minor;

/** Une règle minimale, complétée au cas par cas. */
const rule = (overrides: Partial<FeeRule> = {}): FeeRule =>
  ({
    id: 'r1',
    name: 'Transfert entre clients',
    transactionType: 'TRANSFER',
    userType: null,
    minAmountMinor: null,
    maxAmountMinor: null,
    feeType: 'PERCENT',
    feeValue: 100,
    capMinor: null,
    floorMinor: null,
    tiers: null,
    currency: 'DJF',
    active: true,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as FeeRule;

describe('Calcul des frais', () => {
  it('applique un pourcentage en points de base', () => {
    // 1 % de 5 000 FDJ = 50 FDJ — l'exemple du document d'architecture.
    expect(computeFee(rule(), Money.fromMajor(5000)).format()).toBe('50 FDJ');
  });

  it('applique un montant fixe', () => {
    const frais = computeFee(rule({ feeType: 'FLAT', feeValue: 10000 }), Money.fromMajor(5000));
    expect(frais.format()).toBe('100 FDJ');
  });

  it('respecte le plancher sur les petits montants', () => {
    // 1 % de 500 FDJ = 5 FDJ, relevé au plancher de 25 FDJ : une opération
    // ne doit pas coûter plus cher à traiter qu'elle ne rapporte.
    const frais = computeFee(rule({ floorMinor: fdj(25) }), Money.fromMajor(500));
    expect(frais.format()).toBe('25 FDJ');
  });

  it('respecte le plafond sur les gros montants', () => {
    // 1 % de 200 000 FDJ = 2 000 FDJ, ramené au plafond de 500 FDJ :
    // le gros montant n'est pas puni.
    const frais = computeFee(rule({ capMinor: fdj(500) }), Money.fromMajor(200000));
    expect(frais.format()).toBe('500 FDJ');
  });

  it('applique plancher puis plafond, dans cet ordre', () => {
    const frais = computeFee(
      rule({ floorMinor: fdj(25), capMinor: fdj(500) }),
      Money.fromMajor(5000),
    );
    expect(frais.format()).toBe('50 FDJ');
  });

  it('arrondit sans jamais utiliser de flottant', () => {
    // 1 % de 333 FDJ = 3,33 FDJ, soit 333 unités mineures exactement.
    const frais = computeFee(rule(), Money.fromMajor(333));
    expect(frais.minor).toBe(333n);
  });

  it('calcule des frais nuls pour un tarif gratuit', () => {
    const frais = computeFee(rule({ feeType: 'FLAT', feeValue: 0 }), Money.fromMajor(10000));
    expect(frais.isZero()).toBe(true);
  });

  describe('paliers', () => {
    const parPaliers = rule({
      feeType: 'TIERED',
      tiers: [
        { uptoMinor: String(fdj(1000)), feeType: 'FLAT', feeValue: Number(fdj(10)) },
        { uptoMinor: String(fdj(10000)), feeType: 'FLAT', feeValue: Number(fdj(50)) },
        { uptoMinor: null, feeType: 'PERCENT', feeValue: 50 },
      ] as never,
    });

    it('choisit le premier palier qui couvre le montant', () => {
      expect(computeFee(parPaliers, Money.fromMajor(800)).format()).toBe('10 FDJ');
      expect(computeFee(parPaliers, Money.fromMajor(5000)).format()).toBe('50 FDJ');
    });

    it('utilise le dernier palier, sans borne, au-delà', () => {
      // 0,5 % de 100 000 FDJ = 500 FDJ.
      expect(computeFee(parPaliers, Money.fromMajor(100000)).format()).toBe('500 FDJ');
    });
  });
});

describe('Choix de la règle', () => {
  it('ignore les règles désactivées', () => {
    expect(selectRule([rule({ active: false })], fdj(5000), 'USER')).toBeNull();
  });

  it('ignore les règles hors bornes de montant', () => {
    const bornee = rule({ minAmountMinor: fdj(10000) });
    expect(selectRule([bornee], fdj(5000), 'USER')).toBeNull();
    expect(selectRule([bornee], fdj(20000), 'USER')).not.toBeNull();
  });

  it('préfère une règle visant explicitement le profil', () => {
    const generale = rule({ id: 'generale', userType: null });
    const agent = rule({ id: 'agent', userType: 'AGENT' });

    expect(selectRule([generale, agent], fdj(5000), 'AGENT')?.id).toBe('agent');
    // Un simple client ne bénéficie pas du tarif agent.
    expect(selectRule([generale, agent], fdj(5000), 'USER')?.id).toBe('generale');
  });

  it('préfère la version la plus récente à spécificité égale', () => {
    const v1 = rule({ id: 'v1', version: 1 });
    const v2 = rule({ id: 'v2', version: 2 });
    expect(selectRule([v1, v2], fdj(5000), 'USER')?.id).toBe('v2');
  });
});
