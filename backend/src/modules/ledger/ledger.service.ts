import { Injectable, Logger } from '@nestjs/common';
import {
  LedgerAccount,
  LedgerDirection,
  Prisma,
  Transaction,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { BusinessError, ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../database/prisma.service';
import { LedgerLeg, assertBalanced, balanceDelta, computeBalance, lockOrder } from './ledger.rules';

export interface PostingInput {
  type: TransactionType;
  initiatorId: string;
  /** Montant métier, hors frais. Sert d'affichage, pas de calcul comptable. */
  amountMinor: bigint;
  feeMinor?: bigint;
  currency?: string;
  sourceWalletId?: string;
  destinationWalletId?: string;
  idempotencyKey?: string;
  providerId?: string;
  providerReference?: string;
  metadata?: Prisma.InputJsonValue;
  reversalOfId?: string;

  /**
   * Statut de la transaction créée. COMPLETED par défaut.
   *
   * PROCESSING sert aux opérations qui dépendent d'un partenaire extérieur :
   * l'argent a déjà quitté le portefeuille du client (il ne peut donc pas le
   * dépenser deux fois) mais l'opération n'est pas terminée tant que le
   * partenaire n'a pas confirmé.
   */
  status?: Extract<TransactionStatus, 'COMPLETED' | 'PROCESSING'>;

  /** Les écritures. Leur somme des débits doit égaler celle des crédits. */
  legs: LedgerLeg[];

  /**
   * Contrôle exécuté DANS la transaction, une fois les comptes verrouillés et
   * juste avant l'écriture.
   *
   * POURQUOI ce point d'accroche : un contrôle fait avant d'appeler `post()`
   * lit un état qui peut changer entre la lecture et l'écriture. Deux requêtes
   * simultanées le passent alors toutes les deux. Exécuté ici, il bénéficie du
   * verrou déjà posé sur les comptes — deux opérations du même client sont donc
   * examinées l'une après l'autre, chacune voyant le résultat de la précédente.
   *
   * Le ledger ne sait rien de ce que fait ce contrôle : il lui prête seulement
   * son verrou et son atomicité.
   */
  beforeWrite?: (tx: Prisma.TransactionClient) => Promise<void>;
}

export interface PostingResult {
  transaction: Transaction;
  /** true si la transaction existait déjà (même Idempotency-Key). */
  replayed: boolean;
}

/** Ce qu'on sait d'un compte une fois verrouillé. */
interface LockedAccount {
  account: LedgerAccount;
  balanceMinor: bigint;
  walletId: string | null;
  cachedBalanceMinor: bigint | null;
}

/**
 * Le moteur comptable. C'est le seul endroit du projet où de l'argent bouge.
 *
 * RÈGLE ABSOLUE n°2 : jamais `balance += montant`. Tout mouvement est un
 * ensemble d'écritures équilibrées, écrites dans UNE SEULE transaction
 * PostgreSQL, sous verrou.
 *
 * L'ordre des opérations n'est pas négociable :
 *
 *   1. valider l'équilibre AVANT de toucher la base ;
 *   2. verrouiller les comptes concernés, par UUID croissant ;
 *   3. recalculer les soldes réels DEPUIS LE LEDGER, sous le verrou ;
 *   4. vérifier la provision — ici, et nulle part ailleurs ;
 *   5. écrire la transaction, puis les écritures ;
 *   6. rafraîchir le cache `wallets.available_minor`.
 *
 * Tout cela réussit ensemble ou échoue ensemble. Il n'existe aucun état
 * intermédiaire où l'argent aurait quitté un compte sans arriver sur un autre.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger('Ledger');

  constructor(private readonly prisma: PrismaService) {}

  async post(input: PostingInput): Promise<PostingResult> {
    const currency = input.currency ?? 'DJF';

    // 1. Équilibre vérifié avant tout accès à la base : une erreur de calcul
    //    ne doit jamais consommer un numéro de référence ni un verrou.
    assertBalanced(input.legs);

    // 2. Idempotence, première lecture.
    //
    //    Ce contrôle seul ne suffit PAS : deux requêtes simultanées peuvent le
    //    passer toutes les deux. Le vrai garde-fou est l'index UNIQUE en base,
    //    rattrapé plus bas. Celui-ci évite simplement le travail inutile dans
    //    le cas courant — le client qui réappuie après une coupure réseau.
    if (input.idempotencyKey) {
      const existing = await this.prisma.transaction.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) return { transaction: existing, replayed: true };
    }

    try {
      const transaction = await this.prisma.$transaction(async (tx) => {
        const locked = await this.lockAccounts(tx, input.legs);

        this.assertSufficientFunds(input.legs, locked);

        // Contrôles métier atomiques avec l'écriture (plafonds réglementaires,
        // par exemple). Sous le verrou : voir PostingInput.beforeWrite.
        if (input.beforeWrite) await input.beforeWrite(tx);

        const reference = await this.nextReference(tx);

        const created = await tx.transaction.create({
          data: {
            reference,
            type: input.type,
            amountMinor: input.amountMinor,
            feeMinor: input.feeMinor ?? 0n,
            currency,
            initiatorId: input.initiatorId,
            sourceWalletId: input.sourceWalletId,
            destinationWalletId: input.destinationWalletId,
            idempotencyKey: input.idempotencyKey,
            providerId: input.providerId,
            providerReference: input.providerReference,
            reversalOfId: input.reversalOfId,
            metadata: input.metadata,
            status: input.status ?? TransactionStatus.COMPLETED,
            // La contrainte transactions_completed_at_coherent (PHASE 2)
            // impose une date de fin dès que le statut est COMPLETED — et
            // l'interdit tant que l'opération est en cours.
            completedAt: (input.status ?? 'COMPLETED') === 'COMPLETED' ? new Date() : null,
          },
        });

        await this.writeEntries(tx, created.id, currency, input.legs, locked);
        await this.refreshWalletCaches(tx, locked);

        return created;
      });

      return { transaction, replayed: false };
    } catch (error) {
      // 2 bis. La course perdue sur l'Idempotency-Key : PostgreSQL a rejeté le
      //        doublon. Ce n'est pas une erreur pour le client — c'est
      //        exactement ce que l'idempotence promet. On lui rend l'opération
      //        que l'autre requête vient de créer.
      if (input.idempotencyKey && this.isUniqueViolation(error, 'idempotency_key')) {
        const existing = await this.prisma.transaction.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (existing) return { transaction: existing, replayed: true };
      }
      throw error;
    }
  }

  /**
   * Ouvre une transaction EN ATTENTE, sans aucune écriture comptable.
   *
   * POURQUOI une transaction sans écriture : un dépôt initié ne déplace rien.
   * Le client a demandé à verser 10 000 FDJ, mais tant que le partenaire n'a
   * pas encaissé, cet argent n'existe pas chez nous. L'inscrire au ledger
   * reviendrait à écrire dans les comptes une somme que nous ne détenons pas.
   *
   * La ligne `transactions` existe quand même : elle porte la référence
   * communiquée au client, la clé d'idempotence, et permet de suivre l'état.
   */
  async openPending(input: Omit<PostingInput, 'legs' | 'status'>): Promise<PostingResult> {
    if (input.idempotencyKey) {
      const existing = await this.prisma.transaction.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) return { transaction: existing, replayed: true };
    }

    try {
      const transaction = await this.prisma.$transaction(async (tx) => {
        if (input.beforeWrite) await input.beforeWrite(tx);

        return tx.transaction.create({
          data: {
            reference: await this.nextReference(tx),
            type: input.type,
            status: TransactionStatus.PROCESSING,
            amountMinor: input.amountMinor,
            feeMinor: input.feeMinor ?? 0n,
            currency: input.currency ?? 'DJF',
            initiatorId: input.initiatorId,
            sourceWalletId: input.sourceWalletId,
            destinationWalletId: input.destinationWalletId,
            idempotencyKey: input.idempotencyKey,
            providerId: input.providerId,
            providerReference: input.providerReference,
            metadata: input.metadata,
          },
        });
      });

      return { transaction, replayed: false };
    } catch (error) {
      if (input.idempotencyKey && this.isUniqueViolation(error, 'idempotency_key')) {
        const existing = await this.prisma.transaction.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (existing) return { transaction: existing, replayed: true };
      }
      throw error;
    }
  }

  /**
   * Dénoue une transaction en attente : écrit ses écritures et fixe son statut.
   *
   * Utilisé quand le partenaire confirme (COMPLETED) comme quand il échoue
   * (FAILED, avec les écritures qui rendent l'argent au client).
   *
   * Un échec n'efface rien : les écritures de retour s'ajoutent à celles du
   * départ, et leur somme est nulle. L'historique montre l'argent parti puis
   * revenu — c'est ce qu'un auditeur veut voir, pas une ligne disparue.
   */
  async settle(
    transactionId: string,
    legs: LedgerLeg[],
    options: { status: Extract<TransactionStatus, 'COMPLETED' | 'FAILED'>; failureReason?: string },
  ): Promise<Transaction> {
    assertBalanced(legs);

    return this.prisma.$transaction(async (tx) => {
      // Verrou sur la transaction elle-même : deux webhooks du même partenaire
      // arrivant ensemble ne doivent pas la dénouer deux fois.
      await tx.$queryRaw`
        SELECT "id" FROM "transactions" WHERE "id" = ${transactionId}::uuid FOR UPDATE
      `;

      const transaction = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });

      if (transaction.status !== TransactionStatus.PROCESSING) {
        throw new BusinessError(
          ErrorCode.TRANSACTION_NOT_PENDING,
          `Cette opération n'est plus en attente (statut : ${transaction.status}).`,
          409,
        );
      }

      const locked = await this.lockAccounts(tx, legs);
      this.assertSufficientFunds(legs, locked);

      await this.writeEntries(tx, transaction.id, transaction.currency, legs, locked);
      await this.refreshWalletCaches(tx, locked);

      return tx.transaction.update({
        where: { id: transaction.id },
        data: {
          status: options.status,
          failureReason: options.failureReason?.slice(0, 255),
          // La contrainte de la PHASE 2 exige une date de fin sur COMPLETED.
          completedAt: options.status === TransactionStatus.COMPLETED ? new Date() : null,
        },
      });
    });
  }

  /**
   * Clôt une transaction en attente qui n'a rien déplacé.
   *
   * Cas du dépôt jamais encaissé : aucune écriture n'a été faite au départ, il
   * n'y a donc rien à rendre. On se contente de fermer la ligne.
   */
  async failPending(transactionId: string, reason: string): Promise<Transaction> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "transactions" WHERE "id" = ${transactionId}::uuid FOR UPDATE
      `;

      const transaction = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });

      if (transaction.status !== TransactionStatus.PROCESSING) {
        throw new BusinessError(
          ErrorCode.TRANSACTION_NOT_PENDING,
          `Cette opération n'est plus en attente (statut : ${transaction.status}).`,
          409,
        );
      }

      return tx.transaction.update({
        where: { id: transaction.id },
        data: { status: TransactionStatus.FAILED, failureReason: reason.slice(0, 255) },
      });
    });
  }

  /** Solde réel d'un compte, calculé depuis les écritures. */
  async balanceOf(accountId: string): Promise<bigint> {
    const account = await this.prisma.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } });
    const totals = await this.totalsFor(this.prisma, accountId);
    return computeBalance(account.type, totals);
  }

  /**
   * Relevé de compte, du plus récent au plus ancien.
   *
   * Pagination par curseur et non par `skip` : sur un relevé qui s'allonge en
   * permanence, `skip` fait réafficher ou sauter des lignes dès qu'une nouvelle
   * écriture arrive entre deux pages.
   */
  async statement(accountId: string, options: { limit: number; cursor?: string }) {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { accountId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: options.limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      include: {
        transaction: {
          select: { reference: true, type: true, status: true, completedAt: true },
        },
      },
    });

    const hasMore = entries.length > options.limit;
    const page = hasMore ? entries.slice(0, options.limit) : entries;

    return { entries: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  /**
   * Compare le cache et le ledger pour un portefeuille.
   *
   * `wallets.available_minor` n'est qu'un cache de performance. Si les deux
   * divergent, c'est le ledger qui a raison — et l'écart est un incident à
   * traiter, jamais à corriger en silence. Une tâche quotidienne appellera
   * cette méthode sur tous les portefeuilles (PHASE 13).
   */
  async reconcile(walletId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
      include: { ledgerAccount: true },
    });

    if (!wallet) {
      throw new BusinessError(ErrorCode.WALLET_NOT_FOUND, 'Portefeuille introuvable.', 404);
    }

    if (!wallet.ledgerAccount) {
      throw new BusinessError(
        ErrorCode.INTERNAL_ERROR,
        `Le portefeuille ${walletId} n'a pas de compte de ledger.`,
        500,
      );
    }

    const totals = await this.totalsFor(this.prisma, wallet.ledgerAccount.id);
    const ledgerBalance = computeBalance(wallet.ledgerAccount.type, totals);
    const drift = wallet.availableMinor - ledgerBalance;

    if (drift !== 0n) {
      this.logger.error(
        `Écart de réconciliation sur le portefeuille ${walletId} : cache ${wallet.availableMinor}, ledger ${ledgerBalance}`,
      );
    }

    return {
      walletId,
      cachedMinor: wallet.availableMinor,
      ledgerMinor: ledgerBalance,
      driftMinor: drift,
      consistent: drift === 0n,
    };
  }

  // -------------------------------------------------------------------
  // Interne
  // -------------------------------------------------------------------

  /**
   * Verrouille les comptes concernés, par UUID croissant, et lit leur solde
   * réel sous ce verrou.
   *
   * Un par un, et non en une seule requête : `ORDER BY ... FOR UPDATE` verrouille
   * bien dans l'ordre trié, mais cela dépend du plan choisi par PostgreSQL.
   * Une boucle explicite ne dépend de rien et se relit sans ambiguïté — sur la
   * règle qui empêche les interblocages, l'évidence vaut mieux que la finesse.
   */
  private async lockAccounts(
    tx: Prisma.TransactionClient,
    legs: LedgerLeg[],
  ): Promise<Map<string, LockedAccount>> {
    const ids = lockOrder(legs.map((leg) => leg.accountId));
    const locked = new Map<string, LockedAccount>();

    for (const id of ids) {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "ledger_accounts" WHERE "id" = ${id}::uuid FOR UPDATE
      `;

      if (rows.length === 0) {
        throw new BusinessError(
          ErrorCode.INTERNAL_ERROR,
          `Compte de ledger introuvable : ${id}`,
          500,
        );
      }

      const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { id } });

      if (!account.active) {
        throw new BusinessError(
          ErrorCode.INTERNAL_ERROR,
          `Le compte ${account.code} est désactivé.`,
          409,
        );
      }

      const wallet = await tx.wallet.findUnique({ where: { ledgerAccountId: id } });

      if (wallet && wallet.status !== 'ACTIVE') {
        throw new BusinessError(
          ErrorCode.ACCOUNT_BLOCKED,
          'Ce portefeuille est gelé : aucun mouvement n’est possible.',
          409,
        );
      }

      const totals = await this.totalsFor(tx, id);

      locked.set(id, {
        account,
        balanceMinor: computeBalance(account.type, totals),
        walletId: wallet?.id ?? null,
        cachedBalanceMinor: wallet?.availableMinor ?? null,
      });
    }

    return locked;
  }

  /**
   * Vérifie la provision — SOUS LE VERROU, et à partir du ledger.
   *
   * C'est la parade au risque n°1 (double dépense). Deux retraits simultanés de
   * 10 000 FDJ sur un solde de 10 000 : sans verrou, les deux liraient
   * « 10 000 » et passeraient, laissant −10 000. Ici, le second attend le
   * premier, relit 0, et échoue proprement.
   *
   * Seuls les portefeuilles sont contrôlés. Les comptes système, eux, peuvent
   * être « négatifs » au sens naturel : SYSTEM_CASH diminue quand l'argent
   * sort, c'est normal.
   */
  private assertSufficientFunds(legs: LedgerLeg[], locked: Map<string, LockedAccount>): void {
    const deltas = new Map<string, bigint>();

    for (const leg of legs) {
      const state = locked.get(leg.accountId)!;
      const delta = balanceDelta(state.account.type, leg.direction, leg.amountMinor);
      deltas.set(leg.accountId, (deltas.get(leg.accountId) ?? 0n) + delta);
    }

    for (const [accountId, delta] of deltas) {
      const state = locked.get(accountId)!;
      if (!state.walletId) continue;

      const after = state.balanceMinor + delta;
      if (after < 0n) {
        throw new BusinessError(
          ErrorCode.INSUFFICIENT_FUNDS,
          'Solde insuffisant pour cette opération.',
          409,
          {
            availableMinor: state.balanceMinor.toString(),
            requiredMinor: (-delta).toString(),
          },
        );
      }
    }
  }

  private async writeEntries(
    tx: Prisma.TransactionClient,
    transactionId: string,
    currency: string,
    legs: LedgerLeg[],
    locked: Map<string, LockedAccount>,
  ): Promise<void> {
    // Solde courant par compte, mis à jour au fil des écritures : plusieurs
    // écritures peuvent viser le même compte dans une même transaction.
    const running = new Map<string, bigint>();
    for (const [id, state] of locked) running.set(id, state.balanceMinor);

    for (const leg of legs) {
      const state = locked.get(leg.accountId)!;
      const after =
        running.get(leg.accountId)! +
        balanceDelta(state.account.type, leg.direction, leg.amountMinor);
      running.set(leg.accountId, after);

      await tx.ledgerEntry.create({
        data: {
          transactionId,
          accountId: leg.accountId,
          direction: leg.direction,
          amountMinor: leg.amountMinor,
          balanceAfterMinor: after,
          currency,
          description: leg.description,
        },
      });
    }

    for (const [id, state] of locked) state.balanceMinor = running.get(id)!;
  }

  private async refreshWalletCaches(
    tx: Prisma.TransactionClient,
    locked: Map<string, LockedAccount>,
  ): Promise<void> {
    for (const state of locked.values()) {
      if (!state.walletId) continue;
      await tx.wallet.update({
        where: { id: state.walletId },
        data: { availableMinor: state.balanceMinor },
      });
    }
  }

  private async totalsFor(
    client: Prisma.TransactionClient | PrismaService,
    accountId: string,
  ): Promise<{ debitMinor: bigint; creditMinor: bigint }> {
    const rows = await client.$queryRaw<{ direction: LedgerDirection; total: bigint }[]>`
      SELECT "direction", COALESCE(SUM("amount_minor"), 0)::bigint AS "total"
      FROM "ledger_entries"
      WHERE "account_id" = ${accountId}::uuid
      GROUP BY "direction"
    `;

    let debitMinor = 0n;
    let creditMinor = 0n;
    for (const row of rows) {
      if (row.direction === 'DEBIT') debitMinor = BigInt(row.total);
      else creditMinor = BigInt(row.total);
    }

    return { debitMinor, creditMinor };
  }

  /** TX-2026-000123 — voir la migration qui crée la séquence. */
  private async nextReference(tx: Prisma.TransactionClient): Promise<string> {
    const [row] = await tx.$queryRaw<{ nextval: bigint }[]>`
      SELECT nextval('transaction_reference_seq') AS "nextval"
    `;
    const year = new Date().getFullYear();
    return `TX-${year}-${row.nextval.toString().padStart(6, '0')}`;
  }

  private isUniqueViolation(error: unknown, column: string): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
    if (error.code !== 'P2002') return false;
    const target = error.meta?.target;
    return Array.isArray(target)
      ? target.some((field) => String(field).includes(column))
      : String(target ?? '').includes(column);
  }
}
