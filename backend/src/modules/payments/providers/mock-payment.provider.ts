import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError, ErrorCode } from '../../../common/errors/error-codes';
import {
  AccountInfo,
  PaymentProvider,
  ProviderOperationInput,
  ProviderResult,
  ProviderStatus,
  ProviderWebhookEvent,
} from './payment-provider.interface';

/**
 * Fournisseur simulé — le seul qui existe.
 *
 * Il ne contacte AUCUN service extérieur. Il accepte la demande, renvoie une
 * référence, et s'arrête là : c'est ensuite le webhook qui décide du sort de
 * l'opération, exactement comme le ferait un vrai partenaire.
 *
 * Ce choix est délibéré. Un simulateur qui confirmerait tout seul, tout de
 * suite, donnerait l'illusion que les dépôts fonctionnent — alors que le
 * chemin réellement délicat (attente, webhook, signature, idempotence,
 * montant à revérifier) ne serait jamais emprunté. On préfère un simulateur
 * qui oblige à écrire le vrai code.
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly code = 'MOCK';
  readonly signatureHeader = 'x-provider-signature';

  private readonly logger = new Logger('MockProvider');
  private readonly webhookSecret: string;

  constructor(config: ConfigService) {
    this.webhookSecret = config.getOrThrow<string>('MOCK_PROVIDER_WEBHOOK_SECRET');
  }

  async createDeposit(input: ProviderOperationInput): Promise<ProviderResult> {
    return this.accept(input, 'dépôt');
  }

  async createWithdrawal(input: ProviderOperationInput): Promise<ProviderResult> {
    return this.accept(input, 'retrait');
  }

  async checkStatus(): Promise<ProviderStatus> {
    // Un vrai partenaire répondrait. Le simulateur ne conserve aucun état :
    // dire « SUCCEEDED » ici ferait croire à une confirmation qui n'existe pas.
    return 'PENDING';
  }

  async verifyAccount(account: string): Promise<AccountInfo> {
    // Aucune vérification réelle n'est possible sans partenaire. On renvoie
    // `valid: true` sans nom de titulaire : inventer un nom serait exactement
    // la fausse intégration que la règle n°8 interdit.
    return { account, valid: true };
  }

  /**
   * Signature HMAC-SHA256 du corps brut.
   *
   * Sans cette vérification, n'importe qui connaissant l'adresse du webhook
   * pourrait créditer le compte de son choix avec une simple requête HTTP.
   * C'est le risque n°3 du document d'architecture.
   */
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;

    const attendue = this.sign(rawBody);
    const fournie = Buffer.from(signature);
    const reference = Buffer.from(attendue);

    // Comparaison à temps constant : une comparaison classique s'arrête au
    // premier caractère différent, et le temps de réponse permettrait de
    // reconstituer la signature octet par octet.
    if (fournie.length !== reference.length) return false;
    return timingSafeEqual(fournie, reference);
  }

  /** Utilitaire de développement : calculer la signature d'un corps donné. */
  sign(rawBody: Buffer): string {
    return createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
  }

  parseWebhook(payload: unknown): ProviderWebhookEvent {
    const corps = payload as Record<string, unknown>;

    const externalId = this.requireString(corps, 'eventId');
    const providerReference = this.requireString(corps, 'providerReference');
    const status = this.requireString(corps, 'status');

    if (!['PENDING', 'SUCCEEDED', 'FAILED'].includes(status)) {
      throw new BusinessError(
        ErrorCode.VALIDATION_FAILED,
        `Statut inconnu dans le webhook : ${status}`,
      );
    }

    const amount = corps.amountMinor;
    if (typeof amount !== 'string' && typeof amount !== 'number') {
      throw new BusinessError(
        ErrorCode.VALIDATION_FAILED,
        'Champ amountMinor manquant ou invalide dans le webhook.',
      );
    }

    return {
      externalId,
      eventType: this.requireString(corps, 'eventType'),
      providerReference,
      status: status as ProviderStatus,
      amountMinor: BigInt(amount),
      failureReason: typeof corps.failureReason === 'string' ? corps.failureReason : undefined,
    };
  }

  private async accept(input: ProviderOperationInput, libelle: string): Promise<ProviderResult> {
    const providerReference = `MOCK-${randomBytes(8).toString('hex').toUpperCase()}`;

    // Ni le montant ni le numéro de compte ne sont journalisés : le numéro est
    // une donnée personnelle, et le montant n'apporte rien ici.
    this.logger.log(`Demande de ${libelle} acceptée (référence ${providerReference})`);

    return {
      providerReference,
      status: 'PENDING',
      instructions:
        'Fournisseur simulé : aucune opération réelle. La confirmation doit arriver par webhook.',
    };
  }

  private requireString(corps: Record<string, unknown>, champ: string): string {
    const valeur = corps[champ];
    if (typeof valeur !== 'string' || valeur.length === 0) {
      throw new BusinessError(
        ErrorCode.VALIDATION_FAILED,
        `Champ ${champ} manquant dans le webhook.`,
      );
    }
    return valeur;
  }
}
