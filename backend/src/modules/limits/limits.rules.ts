import { LimitPeriod } from '@prisma/client';

/**
 * Bornes temporelles des plafonds.
 *
 * Fonctions pures : elles se testent sans base et sans horloge réelle, ce qui
 * évite les tests qui échouent une fois par mois, le 1er à minuit.
 *
 * ⚠️ Les bornes sont calculées en heure UTC, comme tout ce qui est stocké en
 * base (`Timestamptz`). Djibouti est à UTC+3 : la journée « plafond » commence
 * donc à 3 h du matin, heure locale. C'est un choix à trancher avec le métier
 * avant la mise en production — voir docs/PHASE_5_TRANSFERS.md.
 */
export function periodStart(period: LimitPeriod, now: Date): Date | null {
  switch (period) {
    case 'SINGLE':
      // Un plafond « par opération » ne regarde aucune période.
      return null;
    case 'DAILY':
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    case 'MONTHLY':
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
}

/** Libellé lisible, pour le message d'erreur envoyé au client. */
export function periodLabel(period: LimitPeriod): string {
  switch (period) {
    case 'SINGLE':
      return 'par opération';
    case 'DAILY':
      return 'journalier';
    case 'MONTHLY':
      return 'mensuel';
  }
}
