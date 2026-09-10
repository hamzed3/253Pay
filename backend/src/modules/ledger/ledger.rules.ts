import { LedgerAccountType, LedgerDirection } from '@prisma/client';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';

/**
 * Les règles de la comptabilité en partie double, en fonctions pures.
 *
 * Elles sont ici, séparées de la base, pour une raison précise : ce sont les
 * règles les plus importantes du projet, et elles doivent pouvoir être testées
 * sans PostgreSQL, en quelques millisecondes, autant de fois qu'on veut.
 *
 * ─────────────────────────────────────────────────────────────────────
 * LA CONVENTION, ET POURQUOI CELLE-CI
 * ─────────────────────────────────────────────────────────────────────
 *
 * Chaque type de compte a un « sens naturel » : le sens dans lequel il
 * augmente.
 *
 *   ASSET (ce que nous possédons)     augmente au DÉBIT
 *   EXPENSE (ce que nous dépensons)   augmente au DÉBIT
 *   LIABILITY (ce que nous devons)    augmente au CRÉDIT
 *   REVENUE (ce que nous gagnons)     augmente au CRÉDIT
 *   EQUITY (les fonds propres)        augmente au CRÉDIT
 *
 * Le portefeuille d'un client est une DETTE (LIABILITY) : cet argent ne nous
 * appartient pas, nous le lui devons. Son solde augmente donc au CRÉDIT.
 *
 * Conséquence, pour un transfert de 5 000 FDJ avec 50 FDJ de frais :
 *
 *   | Compte              | Débit | Crédit |
 *   | Portefeuille payeur | 5 050 |        |   sa dette envers lui diminue
 *   | Portefeuille reçu   |       |  5 000 |   notre dette envers lui augmente
 *   | SYSTEM_REVENUE      |       |     50 |   notre produit augmente
 *   | Total               | 5 050 |  5 050 |
 *
 * C'est la convention comptable standard, celle qu'attend un auditeur ou la
 * Banque Centrale. Elle rend visible dans les comptes le fait que l'argent des
 * clients n'est PAS notre chiffre d'affaires.
 *
 * ⚠️ La section 5 de docs/architecture.md présentait la convention inverse
 * (portefeuille crédité quand il se vide, produits augmentant au débit). Elle a
 * été corrigée : voir docs/PHASE_4_WALLET_LEDGER.md, section « La correction ».
 */

/** Sens dans lequel le compte augmente. */
export function naturalSide(type: LedgerAccountType): LedgerDirection {
  switch (type) {
    case 'ASSET':
    case 'EXPENSE':
      return 'DEBIT';
    case 'LIABILITY':
    case 'REVENUE':
    case 'EQUITY':
      return 'CREDIT';
  }
}

/**
 * Effet d'une écriture sur le solde du compte, signé.
 * Positif si l'écriture va dans le sens naturel du compte, négatif sinon.
 */
export function balanceDelta(
  type: LedgerAccountType,
  direction: LedgerDirection,
  amountMinor: bigint,
): bigint {
  return direction === naturalSide(type) ? amountMinor : -amountMinor;
}

/**
 * Solde d'un compte à partir de ses totaux débit et crédit.
 *
 * Attention : pour un portefeuille client (LIABILITY), c'est
 * `crédits - débits`. La formule inverse donnerait un solde négatif à tout
 * client ayant de l'argent — l'erreur classique quand on applique
 * mécaniquement « débit moins crédit » à tous les comptes.
 */
export function computeBalance(
  type: LedgerAccountType,
  totals: { debitMinor: bigint; creditMinor: bigint },
): bigint {
  const raw = totals.debitMinor - totals.creditMinor;
  return naturalSide(type) === 'DEBIT' ? raw : -raw;
}

export interface LedgerLeg {
  accountId: string;
  direction: LedgerDirection;
  amountMinor: bigint;
  description?: string;
}

/**
 * Vérifie qu'une transaction est équilibrée AVANT d'écrire quoi que ce soit.
 *
 * PostgreSQL le vérifie aussi, au COMMIT (déclencheur `ledger_entries_must_balance`
 * de la PHASE 2). Ce double contrôle n'est pas une redondance inutile :
 *  - ici, l'erreur arrive tôt, avec un message métier clair et le détail des
 *    totaux, ce qui rend le bug immédiatement compréhensible ;
 *  - là-bas, c'est le filet de sécurité que personne ne peut contourner, même
 *    en écrivant directement en base.
 */
export function assertBalanced(legs: LedgerLeg[]): void {
  if (legs.length < 2) {
    throw new BusinessError(
      ErrorCode.LEDGER_UNBALANCED,
      "Un mouvement d'argent exige au moins deux écritures : d'où il vient, où il va.",
      500,
    );
  }

  let debit = 0n;
  let credit = 0n;

  for (const leg of legs) {
    if (leg.amountMinor <= 0n) {
      throw new BusinessError(
        ErrorCode.LEDGER_UNBALANCED,
        'Le montant d’une écriture est toujours strictement positif : le sens est porté par `direction`.',
        500,
      );
    }
    if (leg.direction === 'DEBIT') debit += leg.amountMinor;
    else credit += leg.amountMinor;
  }

  if (debit !== credit) {
    throw new BusinessError(
      ErrorCode.LEDGER_UNBALANCED,
      `Écritures déséquilibrées : ${debit} au débit contre ${credit} au crédit.`,
      500,
      { debitMinor: debit.toString(), creditMinor: credit.toString() },
    );
  }
}

/**
 * Ordre de verrouillage : UUID croissant, TOUJOURS.
 *
 * POURQUOI : deux transferts croisés, A→B et B→A, arrivant en même temps. Si
 * chacun verrouille d'abord son propre compte, le premier tient A et attend B,
 * le second tient B et attend A. Plus personne n'avance : c'est un interblocage,
 * et PostgreSQL finira par tuer l'une des deux transactions.
 *
 * En verrouillant toujours dans le même ordre, cette situation ne peut pas
 * se produire : le second attend simplement que le premier ait terminé.
 */
export function lockOrder(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}
