import { FeeRule, UserRole } from '@prisma/client';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';

/**
 * Calcul des frais, en fonctions pures.
 *
 * RÈGLE ABSOLUE n°3 : le backend décide, le mobile affiche. Les frais ne sont
 * JAMAIS lus dans la requête du client — ils sont recalculés ici, à partir des
 * règles en base. Un client qui enverrait `"fee": 0` n'obtiendrait rien.
 *
 * Et ils ne sont pas écrits en dur dans le code : un changement de tarif ne
 * doit pas exiger un déploiement. Ils vivent dans la table `fee_rules`, avec un
 * numéro de version, ce qui permet d'expliquer six mois plus tard pourquoi
 * telle opération a coûté tel montant.
 */

/** Un palier de la grille TIERED, tel qu'il est stocké en JSON. */
interface FeeTier {
  /** Borne haute du palier, en unité mineure. `null` = pas de borne. */
  uptoMinor: string | null;
  feeType: 'FLAT' | 'PERCENT';
  feeValue: number;
}

/**
 * Choisit la règle applicable.
 *
 * Une règle visant explicitement un profil l'emporte sur une règle générale :
 * si un tarif « agent » existe, il prime sur le tarif « tout le monde ». À
 * spécificité égale, la version la plus récente gagne.
 */
export function selectRule(
  rules: FeeRule[],
  amountMinor: bigint,
  userRole: UserRole,
): FeeRule | null {
  const applicables = rules.filter((rule) => {
    if (!rule.active) return false;
    if (rule.userType !== null && rule.userType !== userRole) return false;
    if (rule.minAmountMinor !== null && amountMinor < rule.minAmountMinor) return false;
    if (rule.maxAmountMinor !== null && amountMinor > rule.maxAmountMinor) return false;
    return true;
  });

  if (applicables.length === 0) return null;

  return applicables.sort((a, b) => {
    const specificite = Number(b.userType !== null) - Number(a.userType !== null);
    return specificite !== 0 ? specificite : b.version - a.version;
  })[0];
}

/**
 * Applique une règle à un montant.
 *
 * Tout est en entiers : `applyRate` travaille en points de base (1 % = 100) et
 * arrondit au demi supérieur. Aucun flottant n'intervient — c'est ce qui rend
 * la caisse réconciliable.
 */
export function computeFee(rule: FeeRule, amount: Money): Money {
  const brut = applyFeeType(rule.feeType, rule.feeValue, rule.tiers, amount);

  // Le plancher garantit que les toutes petites opérations restent rentables ;
  // le plafond évite de punir un gros montant. L'ordre compte : on plafonne
  // après avoir appliqué le plancher.
  let resultat = brut;

  if (rule.floorMinor !== null && resultat.minor < rule.floorMinor) {
    resultat = Money.fromMinor(rule.floorMinor, amount.currency);
  }

  if (rule.capMinor !== null && resultat.minor > rule.capMinor) {
    resultat = Money.fromMinor(rule.capMinor, amount.currency);
  }

  return resultat;
}

function applyFeeType(
  feeType: FeeRule['feeType'],
  feeValue: number,
  tiers: unknown,
  amount: Money,
): Money {
  switch (feeType) {
    case 'FLAT':
      return Money.fromMinor(feeValue, amount.currency);

    case 'PERCENT':
      // feeValue est en points de base : 100 = 1 %.
      return amount.applyRate(feeValue);

    case 'TIERED':
      return applyTiers(tiers, amount);
  }
}

function applyTiers(tiers: unknown, amount: Money): Money {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new BusinessError(
      ErrorCode.INTERNAL_ERROR,
      'Règle de frais par paliers sans paliers définis.',
      500,
    );
  }

  const palier = (tiers as FeeTier[]).find(
    (t) => t.uptoMinor === null || amount.minor <= BigInt(t.uptoMinor),
  );

  if (!palier) {
    throw new BusinessError(
      ErrorCode.INTERNAL_ERROR,
      `Aucun palier de frais ne couvre le montant ${amount.format()}.`,
      500,
    );
  }

  return palier.feeType === 'FLAT'
    ? Money.fromMinor(palier.feeValue, amount.currency)
    : amount.applyRate(palier.feeValue);
}
