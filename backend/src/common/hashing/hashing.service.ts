import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { hash as argon2Hash, verify as argon2Verify, Algorithm } from '@node-rs/argon2';

/**
 * Le hachage du projet, en un seul endroit.
 *
 * DEUX SECRETS, DEUX TRAITEMENTS — c'est la décision importante de ce fichier :
 *
 * 1. PIN et OTP : secrets à FAIBLE entropie.
 *    Un PIN à 4 chiffres, c'est 10 000 possibilités ; un OTP à 6 chiffres,
 *    1 000 000. Avec SHA-256, un attaquant qui vole la base les retrouve tous
 *    en quelques secondes. On utilise donc Argon2id, volontairement LENT et
 *    gourmand en mémoire : chaque essai coûte ~50 ms et 19 Mo. Retrouver un
 *    PIN passe de « quelques secondes » à « des jours par compte ».
 *
 * 2. Refresh tokens : secrets à FORTE entropie.
 *    Ce sont 512 bits tirés au hasard. Il n'existe aucune attaque par
 *    dictionnaire contre eux : personne ne devinera 2^512 possibilités.
 *    Argon2 n'apporterait rien, sinon de la lenteur sur une route appelée
 *    à chaque renouvellement de session. SHA-256 suffit, et il est rapide.
 *
 * La règle générale : ralentir le hachage protège contre la devinette. Si le
 * secret est indevinable, il n'y a rien à ralentir.
 */
@Injectable()
export class HashingService {
  /**
   * Paramètres Argon2id (valeurs recommandées par l'OWASP, profil « 19 Mo »).
   * Les augmenter renforce la sécurité mais ralentit chaque connexion.
   */
  private readonly argonOptions = {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456, // 19 Mo
    timeCost: 2,
    parallelism: 1,
  };

  /** Pour un PIN ou un OTP. Lent, volontairement. */
  async hashSecret(plain: string): Promise<string> {
    return argon2Hash(plain, this.argonOptions);
  }

  /**
   * Vérifie un PIN ou un OTP.
   * Ne lève jamais : un hachage corrompu en base doit se traduire par un refus,
   * pas par une erreur 500 qui révélerait un problème interne.
   */
  async verifySecret(storedHash: string, plain: string): Promise<boolean> {
    try {
      return await argon2Verify(storedHash, plain, this.argonOptions);
    } catch {
      return false;
    }
  }

  /** Pour un token à forte entropie. Rapide, et c'est justifié (voir en-tête). */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Comparaison à temps constant.
   *
   * POURQUOI : une comparaison classique (===) s'arrête au premier caractère
   * différent. Le temps de réponse trahit alors le nombre de caractères
   * corrects, ce qui permet de reconstituer un secret octet par octet.
   */
  safeEquals(a: string, b: string): boolean {
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    if (bufferA.length !== bufferB.length) return false;
    return timingSafeEqual(bufferA, bufferB);
  }
}
