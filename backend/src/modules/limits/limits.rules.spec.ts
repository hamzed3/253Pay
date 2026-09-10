import { periodLabel, periodStart } from './limits.rules';

describe('Bornes des périodes de plafond', () => {
  const maintenant = new Date('2026-09-17T14:35:00.000Z');

  it('un plafond par opération ne regarde aucune période', () => {
    expect(periodStart('SINGLE', maintenant)).toBeNull();
  });

  it('le plafond journalier part de minuit UTC', () => {
    expect(periodStart('DAILY', maintenant)?.toISOString()).toBe('2026-09-17T00:00:00.000Z');
  });

  it('le plafond mensuel part du 1er du mois', () => {
    expect(periodStart('MONTHLY', maintenant)?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('tient au passage d’un mois', () => {
    const premierJanvier = new Date('2027-01-01T00:05:00.000Z');
    expect(periodStart('MONTHLY', premierJanvier)?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(periodStart('DAILY', premierJanvier)?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('donne un libellé lisible pour le message d’erreur', () => {
    expect(periodLabel('DAILY')).toBe('journalier');
    expect(periodLabel('MONTHLY')).toBe('mensuel');
    expect(periodLabel('SINGLE')).toBe('par opération');
  });
});
