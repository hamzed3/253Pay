import { Injectable, Logger } from '@nestjs/common';
import { maskPhone } from '../../../common/phone/phone';

/**
 * Interface d'envoi de SMS.
 *
 * RÈGLE ABSOLUE n°8 : aucune fausse intégration. Il n'existe aujourd'hui
 * AUCUNE connexion avec un opérateur — ni Djibouti Telecom, ni aucune
 * passerelle. Cette interface existe pour que, le jour où un contrat sera
 * signé, une seule classe soit à écrire, sans toucher au reste du code.
 *
 * En attendant, MockSmsSender n'envoie rien du tout et le dit clairement.
 */
export interface SmsSender {
  readonly code: string;
  send(phone: string, message: string): Promise<void>;
}

export const SMS_SENDER = Symbol('SMS_SENDER');

/**
 * Expéditeur simulé.
 *
 * Il ne journalise JAMAIS le contenu du message : celui-ci contient l'OTP
 * (règle absolue n°7). Pour récupérer le code en développement, utilisez
 * OTP_EXPOSE_IN_RESPONSE=true, qui le renvoie dans la réponse HTTP — un
 * réglage que l'application refuse de démarrer avec en production.
 */
@Injectable()
export class MockSmsSender implements SmsSender {
  readonly code = 'MOCK';
  private readonly logger = new Logger('SMS');

  async send(phone: string, message: string): Promise<void> {
    // Le numéro est masqué, le message n'est pas repris. On journalise le
    // fait qu'un envoi a eu lieu, rien de plus.
    this.logger.log(`SMS simulé vers ${maskPhone(phone)} (${message.length} caractères)`);
    return Promise.resolve();
  }
}
