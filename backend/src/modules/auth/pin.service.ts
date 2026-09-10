import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';
import { HashingService } from '../../common/hashing/hashing.service';

/**
 * Durées de blocage successives, en minutes.
 *
 * POURQUOI progressif plutôt qu'un blocage définitif : un blocage définitif au
 * 3ᵉ essai transforme une faute de frappe en appel au support, et donne à un
 * plaisantin le moyen de bloquer n'importe quel compte en connaissant un
 * numéro. Le blocage progressif rend la force brute impraticable (4 chiffres,
 * 10 000 possibilités : il faudrait des années) tout en laissant un client
 * distrait réessayer un quart d'heure plus tard.
 */
const LOCK_DURATIONS_MINUTES = [5, 15, 60, 24 * 60];

/**
 * PIN trop évidents. Ce sont, dans cet ordre, les premiers essayés par
 * quiconque teste un téléphone trouvé dans la rue.
 */
const FORBIDDEN_PINS = new Set([
  '0000',
  '1111',
  '2222',
  '3333',
  '4444',
  '5555',
  '6666',
  '7777',
  '8888',
  '9999',
  '1234',
  '4321',
  '0123',
  '3210',
  '1212',
  '2121',
  '1004',
  '2000',
  '2580',
  '0852',
  '1230',
  '6969',
  '1313',
  '1010',
  '2468',
  '1357',
]);

@Injectable()
export class PinService {
  private readonly length: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly hashing: HashingService,
    config: ConfigService,
  ) {
    this.length = config.get<number>('auth.pin.length', 4);
    this.maxAttempts = config.get<number>('auth.pin.maxAttempts', 3);
  }

  /**
   * Refuse un PIN devinable.
   *
   * `phone` sert à interdire un PIN contenu dans le propre numéro du client :
   * c'est le premier essai d'un voisin ou d'un proche, et le plus efficace.
   */
  assertStrongEnough(pin: string, phone?: string): void {
    if (!new RegExp(`^\\d{${this.length}}$`).test(pin)) {
      throw new BusinessError(
        ErrorCode.PIN_TOO_WEAK,
        `Le code secret doit contenir exactement ${this.length} chiffres.`,
      );
    }

    if (FORBIDDEN_PINS.has(pin)) {
      throw new BusinessError(
        ErrorCode.PIN_TOO_WEAK,
        'Ce code est trop courant. Choisissez-en un autre.',
      );
    }

    // Tous les chiffres identiques (00000, 777777… selon la longueur).
    if (new Set(pin).size === 1) {
      throw new BusinessError(
        ErrorCode.PIN_TOO_WEAK,
        'Un code fait de chiffres identiques est trop facile à deviner.',
      );
    }

    if (this.isSequential(pin)) {
      throw new BusinessError(
        ErrorCode.PIN_TOO_WEAK,
        'Une suite de chiffres est trop facile à deviner.',
      );
    }

    if (phone && phone.replace(/\D/g, '').includes(pin)) {
      throw new BusinessError(
        ErrorCode.PIN_TOO_WEAK,
        'Ce code apparaît dans votre numéro de téléphone.',
      );
    }
  }

  async hash(pin: string): Promise<string> {
    return this.hashing.hashSecret(pin);
  }

  async verify(storedHash: string, pin: string): Promise<boolean> {
    return this.hashing.verifySecret(storedHash, pin);
  }

  /**
   * Calcule l'état du compte après un échec.
   *
   * Ne touche pas la base : la décision et l'écriture sont séparées, ce qui
   * rend la règle testable sans PostgreSQL.
   */
  nextLockState(previousFailedAttempts: number): {
    failedAttempts: number;
    blockedUntil: Date | null;
  } {
    const failedAttempts = previousFailedAttempts + 1;

    if (failedAttempts < this.maxAttempts) {
      return { failedAttempts, blockedUntil: null };
    }

    // 3 échecs -> 1ᵉʳ palier, 4 -> 2ᵉ, etc. Au-delà du dernier palier, on y reste.
    const step = Math.min(failedAttempts - this.maxAttempts, LOCK_DURATIONS_MINUTES.length - 1);
    const minutes = LOCK_DURATIONS_MINUTES[step];

    return { failedAttempts, blockedUntil: new Date(Date.now() + minutes * 60_000) };
  }

  /** Minutes restantes avant de pouvoir réessayer, pour le message d'erreur. */
  remainingLockMinutes(blockedUntil: Date): number {
    return Math.max(1, Math.ceil((blockedUntil.getTime() - Date.now()) / 60_000));
  }

  private isSequential(pin: string): boolean {
    let ascending = true;
    let descending = true;

    for (let i = 1; i < pin.length; i++) {
      const delta = Number(pin[i]) - Number(pin[i - 1]);
      if (delta !== 1) ascending = false;
      if (delta !== -1) descending = false;
    }

    return ascending || descending;
  }
}
