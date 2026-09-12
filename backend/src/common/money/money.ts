import { BusinessError, ErrorCode } from '../errors/error-codes';

/**
 * Money — l'objet qui rend les erreurs d'arrondi structurellement impossibles.
 *
 * RÈGLE ABSOLUE DU PROJET : aucun montant n'est jamais un `number` décimal.
 * En JavaScript, 0.1 + 0.2 = 0.30000000000000004. Sur des milliers de
 * transactions, ces micro-écarts rendent la caisse impossible à réconcilier.
 *
 * On stocke donc des ENTIERS en unité mineure (bigint) :
 *   1 000 FDJ  ->  100000n   (scale = 2)
 *
 * bigint est un type entier de précision illimitée : pas d'arrondi possible.
 */
export const MONEY_SCALE = 2;

export class Money {
  private constructor(
    public readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /** Depuis l'unité mineure (ce qui est stocké en base) : Money.fromMinor(100000n) */
  static fromMinor(minor: bigint | number | string, currency = 'DJF'): Money {
    return new Money(BigInt(minor), currency);
  }

  /** Depuis l'unité affichée à l'utilisateur : Money.fromMajor('1000') = 1 000 FDJ */
  static fromMajor(major: string | number, currency = 'DJF'): Money {
    const text = String(major).trim();
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
      throw new BusinessError(ErrorCode.VALIDATION_FAILED, `Montant invalide : ${major}`);
    }
    const negative = text.startsWith('-');
    const [whole, decimals = ''] = text.replace('-', '').split('.');
    if (decimals.length > MONEY_SCALE) {
      throw new BusinessError(
        ErrorCode.VALIDATION_FAILED,
        `Trop de décimales (maximum ${MONEY_SCALE})`,
      );
    }
    const padded = decimals.padEnd(MONEY_SCALE, '0');
    const minor = BigInt(whole + padded);
    return new Money(negative ? -minor : minor, currency);
  }

  static zero(currency = 'DJF'): Money {
    return new Money(0n, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new BusinessError(
        ErrorCode.CURRENCY_MISMATCH,
        `Devises incompatibles : ${this.currency} et ${other.currency}`,
      );
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  /**
   * Applique un taux exprimé en points de base (1 % = 100 bp).
   * Arrondi au demi supérieur, méthode utilisée en finance.
   * Exemple : 1 % de 10 000 FDJ = 100 FDJ
   */
  applyRate(basisPoints: number): Money {
    if (!Number.isInteger(basisPoints) || basisPoints < 0) {
      throw new BusinessError(ErrorCode.VALIDATION_FAILED, 'Taux invalide');
    }
    const numerator = this.minor * BigInt(basisPoints);
    const denominator = 10000n;
    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    const roundUp = remainder * 2n >= denominator;
    return new Money(roundUp ? quotient + 1n : quotient, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor > other.minor;
  }

  greaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor >= other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  /** Pour l'affichage : "1 000 FDJ" */
  format(): string {
    const negative = this.minor < 0n;
    const absolute = negative ? -this.minor : this.minor;
    const divisor = 10n ** BigInt(MONEY_SCALE);
    const whole = (absolute / divisor).toString();
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${negative ? '-' : ''}${grouped} ${this.currency === 'DJF' ? 'FDJ' : this.currency}`;
  }

  /** bigint n'est pas sérialisable en JSON : on renvoie une chaîne. */
  toJSON(): { amount: string; currency: string; scale: number; formatted: string } {
    return {
      amount: this.minor.toString(),
      currency: this.currency,
      scale: MONEY_SCALE,
      formatted: this.format(),
    };
  }
}
