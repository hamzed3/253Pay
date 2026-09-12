import { Injectable, Logger } from '@nestjs/common';
import { Transaction, User } from '@prisma/client';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { normalizePhone } from '../../common/phone/phone';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FeesService } from '../fees/fees.service';
import { LedgerService } from '../ledger/ledger.service';
import { LimitsService } from '../limits/limits.service';
import { PinService } from '../auth/pin.service';
import { UsersService } from '../users/users.service';
import { CreateTransferDto, QuoteTransferDto } from './dto/transfer.dto';

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

/** Le payeur et son compte de ledger, résolus ensemble. */
interface Party {
  user: User;
  walletId: string;
  accountId: string;
}

@Injectable()
export class TransfersService {
  private readonly logger = new Logger('Transfers');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly fees: FeesService,
    private readonly limits: LimitsService,
    private readonly pin: PinService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Identité réduite du bénéficiaire, pour confirmer avant d'envoyer.
   *
   * Renvoie « Hamze M. » : assez pour vérifier qu'on ne se trompe pas de
   * personne, pas assez pour constituer un annuaire (risque n°12).
   *
   * Cette route reste malgré tout un moyen de savoir QUI possède un compte.
   * C'est un compromis assumé — sans elle, les clients enverraient de l'argent
   * à l'aveugle et se tromperaient de numéro. Il est encadré : authentification
   * obligatoire, limite de débit stricte, et aucune autre donnée exposée.
   */
  async lookupRecipient(phone: string) {
    const normalise = normalizePhone(phone);
    const destinataire = await this.users.findByPhone(normalise);

    if (!destinataire || destinataire.status !== 'ACTIVE') {
      throw new BusinessError(
        ErrorCode.RECIPIENT_NOT_FOUND,
        'Aucun compte 253Pay actif pour ce numéro.',
        404,
      );
    }

    return {
      phone: normalise,
      ...this.users.toLimitedIdentity(destinataire),
    };
  }

  /**
   * Simule un transfert sans rien exécuter.
   *
   * Sert à afficher « vous envoyez 5 000 FDJ, cela vous coûtera 5 050 FDJ »
   * AVANT que le client ne valide. C'est aussi la démonstration que les frais
   * viennent du serveur : le mobile ne les calcule jamais.
   */
  async quote(sender: User, dto: QuoteTransferDto) {
    const montant = Money.fromMajor(dto.amount);
    const destinataire = await this.lookupRecipient(dto.recipientPhone);

    if (destinataire.phone === sender.phone) {
      throw new BusinessError(
        ErrorCode.SELF_TRANSFER_FORBIDDEN,
        'Vous ne pouvez pas vous envoyer de l’argent à vous-même.',
      );
    }

    const devis = await this.fees.quote('TRANSFER', montant, sender.role);

    return {
      recipient: destinataire,
      amount: devis.amount.toJSON(),
      fee: devis.fee.toJSON(),
      total: devis.total.toJSON(),
      feeRule: devis.ruleName,
    };
  }

  /**
   * Exécute un transfert.
   *
   * L'ordre des contrôles est délibéré : ce qui est gratuit et sûr d'abord, ce
   * qui coûte cher ensuite, et l'argent en dernier.
   */
  async execute(
    senderId: string,
    dto: CreateTransferDto,
    idempotencyKey: string,
    context: RequestContext,
  ) {
    const montant = Money.fromMajor(dto.amount);

    const payeur = await this.resolveParty(senderId);
    const beneficiaire = await this.resolvePartyByPhone(dto.recipientPhone);

    if (payeur.user.id === beneficiaire.user.id) {
      throw new BusinessError(
        ErrorCode.SELF_TRANSFER_FORBIDDEN,
        'Vous ne pouvez pas vous envoyer de l’argent à vous-même.',
      );
    }

    if (beneficiaire.user.status !== 'ACTIVE') {
      throw new BusinessError(
        ErrorCode.RECIPIENT_NOT_FOUND,
        'Le compte du bénéficiaire n’est pas actif.',
        409,
      );
    }

    // Le PIN confirme l'INTENTION. Un téléphone déverrouillé et posé sur une
    // table ne doit pas suffire à vider un compte.
    await this.verifyPin(payeur.user, dto.pin, context);

    // Les frais sont recalculés ici, à partir de la base. Le client n'en a
    // jamais envoyé, et le devis qu'il a vu n'engage pas le serveur.
    const devis = await this.fees.quote('TRANSFER', montant, payeur.user.role);

    // Les écritures. Le payeur débourse montant + frais ; le bénéficiaire
    // reçoit le montant ; la différence est notre produit.
    const legs = [
      {
        accountId: payeur.accountId,
        direction: 'DEBIT' as const,
        amountMinor: devis.total.minor,
        description: `Transfert vers ${beneficiaire.user.phone}`,
      },
      {
        accountId: beneficiaire.accountId,
        direction: 'CREDIT' as const,
        amountMinor: devis.amount.minor,
        description: `Transfert reçu de ${payeur.user.phone}`,
      },
    ];

    if (devis.fee.isPositive()) {
      legs.push({
        accountId: await this.systemAccountId('SYSTEM_REVENUE'),
        direction: 'CREDIT' as const,
        amountMinor: devis.fee.minor,
        description: 'Frais de transfert',
      });
    }

    const { transaction, replayed } = await this.ledger.post({
      type: 'TRANSFER',
      initiatorId: payeur.user.id,
      amountMinor: devis.amount.minor,
      feeMinor: devis.fee.minor,
      currency: montant.currency,
      sourceWalletId: payeur.walletId,
      destinationWalletId: beneficiaire.walletId,
      idempotencyKey,
      metadata: dto.note ? { note: dto.note } : undefined,
      legs,

      // Contrôle réglementaire, sur le montant transféré (hors frais).
      //
      // Exécuté DANS la transaction du ledger, sous le verrou du compte du
      // payeur. Fait avant l'appel, il laissait passer trois envois simultanés
      // de 5 000 FDJ sur un plafond journalier de 10 000 : chacun lisait un
      // cumul de zéro. Vérifié — c'était reproductible à chaque essai.
      beforeWrite: (tx) =>
        this.limits.assertWithinLimits(payeur.user, 'TRANSFER', montant, { client: tx }),
    });

    if (!replayed) {
      await this.audit.record({
        actorId: payeur.user.id,
        actorRole: payeur.user.role,
        action: 'TRANSFER_EXECUTED',
        entityType: 'Transaction',
        entityId: transaction.id,
        after: {
          reference: transaction.reference,
          amountMinor: transaction.amountMinor.toString(),
          feeMinor: transaction.feeMinor.toString(),
          recipientId: beneficiaire.user.id,
        },
        ip: context.ip,
        userAgent: context.userAgent,
      });
    }

    return {
      // `replayed` est renvoyé sans détour : l'application mobile peut ainsi
      // afficher « déjà envoyé » plutôt que de laisser croire à un doublon.
      replayed,
      ...this.toReceipt(transaction, beneficiaire.user),
    };
  }

  /** Historique des transferts du client, entrants et sortants. */
  async history(userId: string, options: { limit: number; cursor?: string }) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId_currency: { userId, currency: 'DJF' } },
    });

    if (!wallet) {
      throw new BusinessError(ErrorCode.WALLET_NOT_FOUND, 'Aucun portefeuille.', 404);
    }

    const transactions = await this.prisma.transaction.findMany({
      where: {
        OR: [{ sourceWalletId: wallet.id }, { destinationWalletId: wallet.id }],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: options.limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });

    const hasMore = transactions.length > options.limit;
    const page = hasMore ? transactions.slice(0, options.limit) : transactions;

    return {
      transfers: page.map((transaction) => ({
        id: transaction.id,
        reference: transaction.reference,
        type: transaction.type,
        status: transaction.status,
        sens: transaction.sourceWalletId === wallet.id ? 'sortant' : 'entrant',
        amount: Money.fromMinor(transaction.amountMinor, transaction.currency).toJSON(),
        // Les frais ne concernent que le payeur : les afficher au bénéficiaire
        // laisserait croire qu'on lui a prélevé quelque chose.
        fee:
          transaction.sourceWalletId === wallet.id
            ? Money.fromMinor(transaction.feeMinor, transaction.currency).toJSON()
            : null,
        date: transaction.completedAt ?? transaction.createdAt,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /**
   * Annule un transfert terminé.
   *
   * RÈGLE ABSOLUE n°4 : on ne supprime ni ne modifie jamais une transaction
   * COMPLETED. On écrit une transaction INVERSE de type REVERSAL qui pointe
   * vers l'originale. L'historique reste vrai : on voit le transfert, puis son
   * annulation — c'est ce qu'exigera un auditeur.
   *
   * Réservé aux administrateurs : un client ne peut pas défaire un paiement
   * qu'il a validé, sinon plus aucun marchand ne serait payé.
   */
  async reverse(transactionId: string, admin: User, reason: string, context: RequestContext) {
    const originale = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { entries: true, reversedBy: true },
    });

    if (!originale) {
      throw new BusinessError(ErrorCode.NOT_FOUND, 'Transaction introuvable.', 404);
    }

    if (originale.status !== 'COMPLETED') {
      throw new BusinessError(
        ErrorCode.TRANSACTION_NOT_REVERSIBLE,
        `Seule une transaction COMPLETED peut être annulée (statut actuel : ${originale.status}).`,
        409,
      );
    }

    if (originale.reversedBy) {
      throw new BusinessError(
        ErrorCode.TRANSACTION_NOT_REVERSIBLE,
        'Cette transaction a déjà été annulée.',
        409,
      );
    }

    // Les écritures inverses : chaque débit devient un crédit, et l'inverse.
    // Le bénéficiaire est donc débité — s'il a déjà dépensé l'argent, le
    // contrôle de provision du ledger fera échouer l'annulation. C'est
    // volontaire : on ne met pas un compte client en négatif.
    const legs = originale.entries.map((entry) => ({
      accountId: entry.accountId,
      direction: entry.direction === 'DEBIT' ? ('CREDIT' as const) : ('DEBIT' as const),
      amountMinor: entry.amountMinor,
      description: `Annulation de ${originale.reference}`,
    }));

    const { transaction } = await this.ledger.post({
      type: 'REVERSAL',
      initiatorId: admin.id,
      amountMinor: originale.amountMinor,
      feeMinor: originale.feeMinor,
      currency: originale.currency,
      // Source et destination inversées, pour que l'historique se lise bien.
      sourceWalletId: originale.destinationWalletId ?? undefined,
      destinationWalletId: originale.sourceWalletId ?? undefined,
      reversalOfId: originale.id,
      metadata: { reason },
      legs,
    });

    // Seule évolution autorisée après COMPLETED, et le déclencheur PostgreSQL
    // de la PHASE 2 ne laisserait rien passer d'autre.
    await this.prisma.transaction.update({
      where: { id: originale.id },
      data: { status: 'REVERSED' },
    });

    await this.audit.record({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'TRANSFER_REVERSED',
      entityType: 'Transaction',
      entityId: originale.id,
      before: { status: 'COMPLETED', reference: originale.reference },
      after: { status: 'REVERSED', reversalReference: transaction.reference },
      reason,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    this.logger.warn(`Transaction ${originale.reference} annulée par ${admin.id} : ${reason}`);

    return {
      reversal: {
        id: transaction.id,
        reference: transaction.reference,
        amount: Money.fromMinor(transaction.amountMinor, transaction.currency).toJSON(),
      },
      original: { id: originale.id, reference: originale.reference, status: 'REVERSED' },
    };
  }

  // -------------------------------------------------------------------
  // Interne
  // -------------------------------------------------------------------

  /**
   * Vérifie le PIN en passant par le MÊME compteur d'échecs que la connexion.
   *
   * Sans cela, cette route deviendrait un moyen de tester les codes secrets
   * sans jamais déclencher le blocage progressif : il suffirait d'enchaîner
   * les tentatives de transfert. Le garde-fou doit être partagé, pas dupliqué.
   */
  private async verifyPin(user: User, pin: string, context: RequestContext): Promise<void> {
    if (user.blockedUntil && user.blockedUntil.getTime() > Date.now()) {
      const minutes = this.pin.remainingLockMinutes(user.blockedUntil);
      throw new BusinessError(
        ErrorCode.ACCOUNT_BLOCKED,
        `Trop de tentatives. Réessayez dans ${minutes} minute(s).`,
        423,
        { retryAfterMinutes: minutes },
      );
    }

    if (await this.pin.verify(user.pinHash, pin)) {
      if (user.failedPinAttempts > 0) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { failedPinAttempts: 0, blockedUntil: null },
        });
      }
      return;
    }

    const state = this.pin.nextLockState(user.failedPinAttempts);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedPinAttempts: state.failedAttempts, blockedUntil: state.blockedUntil },
    });

    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: state.blockedUntil ? 'AUTH_ACCOUNT_LOCKED' : 'AUTH_PIN_FAILED',
      entityType: 'User',
      entityId: user.id,
      reason: `Confirmation de transfert, tentative ${state.failedAttempts}`,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    throw new BusinessError(ErrorCode.INVALID_CREDENTIALS, 'Code secret incorrect.', 401);
  }

  private async resolveParty(userId: string): Promise<Party> {
    const user = await this.users.getByIdOrThrow(userId);
    return this.attachWallet(user);
  }

  private async resolvePartyByPhone(phone: string): Promise<Party> {
    const user = await this.users.findByPhone(normalizePhone(phone));

    if (!user) {
      throw new BusinessError(
        ErrorCode.RECIPIENT_NOT_FOUND,
        'Aucun compte 253Pay pour ce numéro.',
        404,
      );
    }

    return this.attachWallet(user);
  }

  private async attachWallet(user: User): Promise<Party> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId_currency: { userId: user.id, currency: 'DJF' } },
    });

    if (!wallet?.ledgerAccountId) {
      throw new BusinessError(
        ErrorCode.WALLET_NOT_FOUND,
        'Aucun portefeuille pour ce compte.',
        404,
      );
    }

    return { user, walletId: wallet.id, accountId: wallet.ledgerAccountId };
  }

  private async systemAccountId(code: string): Promise<string> {
    const account = await this.prisma.ledgerAccount.findUnique({ where: { code } });

    if (!account) {
      // Le plan comptable est chargé par `npm run prisma:seed`. Son absence est
      // une erreur d'installation, pas une erreur du client.
      throw new BusinessError(
        ErrorCode.INTERNAL_ERROR,
        `Compte système ${code} absent. Avez-vous lancé « npm run prisma:seed » ?`,
        500,
      );
    }

    return account.id;
  }

  private toReceipt(transaction: Transaction, recipient: User) {
    return {
      id: transaction.id,
      reference: transaction.reference,
      status: transaction.status,
      recipient: this.users.toLimitedIdentity(recipient),
      amount: Money.fromMinor(transaction.amountMinor, transaction.currency).toJSON(),
      fee: Money.fromMinor(transaction.feeMinor, transaction.currency).toJSON(),
      total: Money.fromMinor(
        transaction.amountMinor + transaction.feeMinor,
        transaction.currency,
      ).toJSON(),
      date: transaction.completedAt ?? transaction.createdAt,
    };
  }
}
