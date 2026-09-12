import { BusinessError, ErrorCode } from '../errors/error-codes';

/**
 * Normalisation des numéros de téléphone djiboutiens.
 *
 * POURQUOI c'est important : le téléphone est l'IDENTIFIANT du compte, avec un
 * index UNIQUE en base. Si « 77 12 34 56 », « 77123456 » et « +25377123456 »
 * entrent tels quels, le même client peut créer trois comptes — et
 * l'unicité ne protège plus rien.
 *
 * Toute entrée est donc ramenée à UNE seule forme canonique : +253XXXXXXXX.
 */
export const DJIBOUTI_DIALING_CODE = '253';

/**
 * Préfixes mobiles connus à Djibouti. Les lignes fixes (21…) sont refusées :
 * un wallet a besoin d'un numéro capable de recevoir un SMS.
 *
 * ⚠️ À confirmer auprès de l'opérateur avant la mise en production : un
 * nouveau préfixe mobile mis en service bloquerait sinon les inscriptions.
 */
export const DJIBOUTI_MOBILE_PREFIXES = ['77'];

/** Longueur du numéro national, indicatif pays exclu. */
const NATIONAL_NUMBER_LENGTH = 8;

/**
 * Ramène un numéro à sa forme canonique +253XXXXXXXX.
 * Lève une BusinessError si le numéro n'est pas un mobile djiboutien valide.
 */
export function normalizePhone(input: string): string {
  const raw = String(input ?? '').trim();

  // On retire tout ce qui n'est ni un chiffre ni le + initial :
  // espaces, points, tirets, parenthèses.
  let digits = raw.replace(/[\s.\-()]/g, '');

  // 00253… est l'écriture internationale ancienne de +253…
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  if (digits.startsWith('+')) digits = digits.slice(1);

  if (!/^\d+$/.test(digits)) {
    throw new BusinessError(
      ErrorCode.PHONE_INVALID,
      'Numéro de téléphone invalide : chiffres attendus.',
    );
  }

  // Avec ou sans indicatif pays, on veut le numéro national.
  let national = digits;
  if (digits.startsWith(DJIBOUTI_DIALING_CODE) && digits.length > NATIONAL_NUMBER_LENGTH) {
    national = digits.slice(DJIBOUTI_DIALING_CODE.length);
  }

  // Certains saisissent un 0 devant, par habitude d'autres pays.
  if (national.length === NATIONAL_NUMBER_LENGTH + 1 && national.startsWith('0')) {
    national = national.slice(1);
  }

  if (national.length !== NATIONAL_NUMBER_LENGTH) {
    throw new BusinessError(
      ErrorCode.PHONE_INVALID,
      `Numéro de téléphone invalide : ${NATIONAL_NUMBER_LENGTH} chiffres attendus après l'indicatif +${DJIBOUTI_DIALING_CODE}.`,
    );
  }

  if (!DJIBOUTI_MOBILE_PREFIXES.some((prefix) => national.startsWith(prefix))) {
    throw new BusinessError(
      ErrorCode.PHONE_INVALID,
      `Numéro de mobile attendu (commençant par ${DJIBOUTI_MOBILE_PREFIXES.join(' ou ')}).`,
    );
  }

  return `+${DJIBOUTI_DIALING_CODE}${national}`;
}

/**
 * Version affichable, partiellement masquée : +253 77 ** ** 56
 *
 * Utilisée partout où un numéro apparaît sans être strictement nécessaire
 * (accusés de réception, écrans de confirmation). Un numéro complet affiché
 * est une donnée personnelle exposée pour rien.
 */
export function maskPhone(phone: string): string {
  const national = phone.replace(`+${DJIBOUTI_DIALING_CODE}`, '');
  if (national.length !== NATIONAL_NUMBER_LENGTH) return '***';
  return `+${DJIBOUTI_DIALING_CODE} ${national.slice(0, 2)} ** ** ${national.slice(6)}`;
}
