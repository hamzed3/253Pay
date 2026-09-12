import { Injectable, Logger } from '@nestjs/common';
import { Prisma, Transaction } from '@prisma/client';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { PrismaService } from '../../database/prisma.service';
import { DepositsService } from '../deposits/deposits.service';
import { ProviderRegistry } from '../payments/provider-registry.service';
import { ProviderWebhookEvent } from '../payments/providers/payment-provider.interface';
import { WithdrawalsService } from '../withdrawals/withdrawals.service';

/**
 * Réception des notifications de partenaires.
 *
 * C'est la porte la plus exposée de toute l'application : elle est publique,
 * et elle déclenche des mouvements d'argent. Les cinq règles du document
 * d'architecture sont appliquées dans cet ordre :
 *
 * 1. Vérifier la signature AVANT tout traitement. Sans elle, n'importe qui
 *    crédite le compte de son choix avec une requête HTTP (risque n°3).
 * 2. Idempotence par `external_id` UNIQUE : les partenaires renvoient souvent
 *    le même événement plusieurs fois.
 * 3. Répondre 200 rapidement.
 * 4. Tout journaliser, y compris les messages rejetés — ce sont les traces
 *    d'une tentative de fraude.
 * 5. Ne JAMAIS croire le montant annoncé : le comparer à la transaction locale.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger('Webhooks');

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistry,
    private readonly deposits: DepositsService,
    private readonly withdrawals: WithdrawalsService,
  ) {}

  async handle(
    providerCode: string,
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<{ received: true; status: string }> {
    const provider = this.providers.find(providerCode);

    if (!provider) {
      throw new BusinessError(ErrorCode.PROVIDER_UNAVAILABLE, 'Fournisseur inconnu.', 404);
    }

    const ligne = await this.prisma.paymentProvider.findUnique({ where: { code: providerCode } });

    // --- 1. Signature ---
    if (!provider.verifySignature(rawBody, signature)) {
      await this.journaliserRejet(ligne?.id, rawBody, 'Signature invalide');

      this.logger.error(`Webhook ${providerCode} rejeté : signature invalide`);

      // Le message ne dit pas ce qui cloche : un attaquant ne doit pas pouvoir
      // s'en servir pour ajuster ses essais.
      throw new BusinessError(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'Signature invalide.', 401);
    }

    const evenement = provider.parseWebhook(JSON.parse(rawBody.toString('utf8')));

    // --- 2. Idempotence ---
    const existant = await this.prisma.webhookEvent.findUnique({
      where: { externalId: evenement.externalId },
    });

    if (existant?.processedAt) {
      // Déjà traité : on répond 200 sans rien refaire. Répondre une erreur
      // ferait réessayer le partenaire indéfiniment.
      this.logger.log(`Webhook ${evenement.externalId} déjà traité, ignoré`);
      return { received: true, status: 'already_processed' };
    }

    let enregistrement = existant;

    if (!enregistrement) {
      try {
        enregistrement = await this.prisma.webhookEvent.create({
          data: {
            providerId: ligne?.id,
            eventType: evenement.eventType,
            externalId: evenement.externalId,
            signatureValid: true,
            payload: JSON.parse(rawBody.toString('utf8')) as Prisma.InputJsonValue,
          },
        });
      } catch (error) {
        // La lecture ci-dessus ne suffit pas : deux notifications identiques
        // arrivant ensemble la passent toutes les deux, et la seconde heurte
        // l'index UNIQUE sur external_id. C'est précisément le rôle de cet
        // index — encore faut-il traduire son refus autrement qu'en 500.
        //
        // Une autre requête traite déjà cet événement : on répond 200. Le
        // partenaire n'a rien à rejouer.
        if (this.isDuplicateEvent(error)) {
          this.logger.log(`Webhook ${evenement.externalId} déjà en cours de traitement, ignoré`);
          return { received: true, status: 'already_processing' };
        }
        throw error;
      }
    }

    try {
      const resultat = await this.traiter(evenement);

      await this.prisma.webhookEvent.update({
        where: { id: enregistrement.id },
        data: { processedAt: new Date(), attempts: { increment: 1 } },
      });

      return { received: true, status: resultat };
    } catch (error) {
      // L'événement reste non traité : le partenaire réessaiera, et la ligne
      // garde la trace de l'échec pour l'exploitation.
      await this.prisma.webhookEvent.update({
        where: { id: enregistrement.id },
        data: { attempts: { increment: 1 }, lastError: (error as Error).message.slice(0, 500) },
      });
      throw error;
    }
  }

  private async traiter(evenement: ProviderWebhookEvent): Promise<string> {
    const transaction = await this.prisma.transaction.findFirst({
      where: { providerReference: evenement.providerReference },
    });

    if (!transaction) {
      throw new BusinessError(
        ErrorCode.NOT_FOUND,
        `Aucune opération ne correspond à la référence ${evenement.providerReference}.`,
        404,
      );
    }

    if (transaction.status !== 'PROCESSING') {
      // Arrive quand deux événements différents portent sur la même opération.
      this.logger.warn(
        `Opération ${transaction.reference} déjà dénouée (${transaction.status}), événement ignoré`,
      );
      return 'already_settled';
    }

    // ⚠️ Ce contrôle ne suffit pas. Entre cette lecture et le dénouement, une
    // autre notification du même partenaire peut avoir terminé l'opération —
    // c'est exactement ce qui arrive quand il renvoie deux fois le même
    // événement en parallèle. Le second se voyait alors refuser avec une 409,
    // et le partenaire le rejouait indéfiniment pour rien.
    //
    // La vraie protection est le verrou posé dans LedgerService.settle. Il
    // reste à traduire son refus en réponse compréhensible : ce n'est pas une
    // erreur, c'est un doublon.

    // --- 5. Le montant annoncé est vérifié, jamais cru ---
    this.assertMontantCoherent(transaction, evenement);

    if (evenement.status === 'PENDING') return 'still_pending';

    const succes = evenement.status === 'SUCCEEDED';
    const raison = evenement.failureReason ?? 'Refusé par le partenaire';

    try {
      if (transaction.type === 'DEPOSIT') {
        if (succes) await this.deposits.confirm(transaction);
        else await this.deposits.reject(transaction, raison);
      } else if (transaction.type === 'WITHDRAWAL') {
        if (succes) await this.withdrawals.confirm(transaction);
        else await this.withdrawals.reject(transaction, raison);
      } else {
        throw new BusinessError(
          ErrorCode.INTERNAL_ERROR,
          `Type d'opération non géré par les webhooks : ${transaction.type}.`,
          500,
        );
      }
    } catch (error) {
      if (error instanceof BusinessError && error.code === ErrorCode.TRANSACTION_NOT_PENDING) {
        // Une autre notification a gagné la course. L'opération est dénouée :
        // c'est le résultat attendu, pas un échec.
        this.logger.warn(
          `Opération ${transaction.reference} dénouée entre-temps par une autre notification`,
        );
        return 'already_settled';
      }
      throw error;
    }

    return succes ? 'settled' : 'failed';
  }

  /**
   * Compare le montant annoncé à celui de notre transaction.
   *
   * C'est la dernière barrière : même signé, un message annonçant
   * « 1 000 000 FDJ encaissés » pour un dépôt de 10 000 doit être refusé. Un
   * partenaire peut se tromper ; une clé peut fuiter.
   */
  private assertMontantCoherent(transaction: Transaction, evenement: ProviderWebhookEvent): void {
    if (evenement.amountMinor === transaction.amountMinor) return;

    this.logger.error(
      `Montant incohérent sur ${transaction.reference} : annoncé ${evenement.amountMinor}, attendu ${transaction.amountMinor}`,
    );

    throw new BusinessError(
      ErrorCode.AMOUNT_MISMATCH,
      'Le montant annoncé ne correspond pas à celui de l’opération.',
      409,
      {
        expected: Money.fromMinor(transaction.amountMinor, transaction.currency).toJSON(),
        received: Money.fromMinor(evenement.amountMinor, transaction.currency).toJSON(),
      },
    );
  }

  /** Reconnaît le refus de l'index UNIQUE sur `webhook_events.external_id`. */
  private isDuplicateEvent(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      String(error.meta?.target ?? '').includes('external_id')
    );
  }

  /**
   * Conserve un message rejeté.
   *
   * Un payload à signature invalide n'est pas un déchet : c'est la trace d'une
   * tentative d'intrusion, et elle doit rester consultable. `external_id` étant
   * UNIQUE, on lui donne une clé propre — le contenu n'est pas digne de
   * confiance, donc on n'en tire aucun identifiant.
   */
  private async journaliserRejet(
    providerId: string | undefined,
    rawBody: Buffer,
    raison: string,
  ): Promise<void> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          providerId,
          eventType: 'REJECTED',
          externalId: `rejected:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
          signatureValid: false,
          // Tronqué : un attaquant pourrait envoyer un corps énorme.
          payload: { raw: rawBody.toString('utf8').slice(0, 4000) },
          lastError: raison,
        },
      });
    } catch (error) {
      this.logger.error(
        `Impossible de journaliser le webhook rejeté : ${(error as Error).message}`,
      );
    }
  }
}
