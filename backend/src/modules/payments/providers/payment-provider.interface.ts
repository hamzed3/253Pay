/**
 * L'abstraction fournisseur de paiement.
 *
 * L'erreur classique consiste à écrire le code d'un partenaire un peu partout :
 * le jour où il change, tout est à refaire. Ici, le reste de l'application ne
 * connaît QUE cette interface. Le jour où un accord sera signé avec D-Money,
 * une banque ou un opérateur, il y aura une classe à écrire — et rien d'autre
 * à modifier dans les modules dépôts, retraits ou webhooks.
 *
 * ⚠️ RÈGLE ABSOLUE n°8 : aucune fausse intégration. À ce jour, il n'existe
 * AUCUNE connexion avec un partenaire réel, et il n'y en aura pas tant qu'il
 * n'y aura pas une API officielle ET un accord signé. Seul MockPaymentProvider
 * existe, et il ne contacte rien.
 */

export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');

/** Ce que le partenaire répond quand on lui demande d'encaisser ou de payer. */
export interface ProviderResult {
  /** Référence chez le partenaire. C'est elle qui reviendra dans le webhook. */
  providerReference: string;
  status: ProviderStatus;
  /** Instructions à afficher au client (composer un code USSD, par exemple). */
  instructions?: string;
}

export type ProviderStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export interface ProviderOperationInput {
  /** Notre référence interne, transmise au partenaire pour rapprochement. */
  reference: string;
  amountMinor: bigint;
  currency: string;
  /** Numéro de téléphone ou de compte chez le partenaire. */
  account: string;
}

export interface AccountInfo {
  account: string;
  valid: boolean;
  /** Nom partiel renvoyé par le partenaire, s'il en fournit un. */
  holderName?: string;
}

/** Événement reçu d'un partenaire, une fois la signature vérifiée. */
export interface ProviderWebhookEvent {
  /** Identifiant de l'événement CHEZ LE PARTENAIRE. Sert à l'idempotence. */
  externalId: string;
  eventType: string;
  providerReference: string;
  status: ProviderStatus;
  /**
   * Montant annoncé par le partenaire.
   *
   * ⚠️ À NE JAMAIS CROIRE SUR PAROLE : il doit être comparé à la transaction
   * locale avant tout mouvement. Un partenaire qui se trompe, ou un attaquant
   * qui forge un message, annoncerait sinon le montant de son choix.
   */
  amountMinor: bigint;
  failureReason?: string;
}

export interface PaymentProvider {
  readonly code: string;

  /** Nom de l'en-tête HTTP portant la signature des webhooks. */
  readonly signatureHeader: string;

  /** Demande au partenaire d'encaisser de l'argent pour nous. */
  createDeposit(input: ProviderOperationInput): Promise<ProviderResult>;

  /** Demande au partenaire de verser de l'argent à un client. */
  createWithdrawal(input: ProviderOperationInput): Promise<ProviderResult>;

  /** Interroge le partenaire sur une opération — utile si un webhook se perd. */
  checkStatus(providerReference: string): Promise<ProviderStatus>;

  /** Vérifie qu'un numéro de compte existe chez le partenaire. */
  verifyAccount(account: string): Promise<AccountInfo>;

  /**
   * Vérifie la signature d'un webhook.
   *
   * Reçoit le corps BRUT de la requête, pas l'objet déjà analysé : re-sérialiser
   * du JSON ne redonne pas les mêmes octets (ordre des clés, espaces), et la
   * signature ne correspondrait plus.
   */
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean;

  /** Traduit le corps du webhook en événement compréhensible par l'application. */
  parseWebhook(payload: unknown): ProviderWebhookEvent;
}
