/**
 * Données de référence de 253Pay.
 *
 * Ce script est IDEMPOTENT : on peut le relancer autant de fois qu'on veut,
 * il ne crée jamais de doublon. Il ne contient QUE des données de référence
 * (plan comptable, tarifs, plafonds) — jamais de faux clients ni de faux
 * argent.
 *
 *   npm run prisma:seed
 */
import { PrismaClient } from '@prisma/client';
import { Money } from '../src/common/money/money';

const prisma = new PrismaClient();

/** Raccourci : 1 000 FDJ -> 100000n. Jamais de zéros écrits à la main. */
const fdj = (major: string | number): bigint => Money.fromMajor(major, 'DJF').minor;

/**
 * Plan comptable système.
 *
 * Convention : ASSET et EXPENSE augmentent au DÉBIT ; LIABILITY, REVENUE et
 * EQUITY augmentent au CRÉDIT.
 *
 * Le portefeuille d'un client est une DETTE (LIABILITY) de 253Pay envers lui :
 * cet argent ne nous appartient pas, nous le lui devons. C'est exactement ce
 * qu'un régulateur veut voir : l'argent des clients n'est pas notre chiffre
 * d'affaires.
 */
async function seedSystemAccounts(): Promise<void> {
  const accounts = [
    {
      code: 'SYSTEM_CASH',
      name: 'Trésorerie — espèces et comptes bancaires',
      type: 'ASSET' as const,
      // La contrepartie réelle : ce que 253Pay détient effectivement en banque
      // ou chez ses partenaires. Un dépôt ne crée pas d'argent, il le déplace.
    },
    {
      code: 'SYSTEM_REVENUE',
      name: 'Produits — frais encaissés',
      type: 'REVENUE' as const,
    },
    {
      code: 'SYSTEM_COMMISSION',
      name: 'Commissions dues aux agents',
      type: 'LIABILITY' as const,
      // Une commission due n'est pas encore payée : c'est une dette.
    },
    {
      code: 'SYSTEM_SUSPENSE',
      name: 'Compte d’attente — opérations non confirmées',
      type: 'LIABILITY' as const,
      // Un dépôt initié mais pas confirmé par le partenaire attend ici.
      // Ce compte doit revenir à zéro : un solde qui traîne est une alerte.
    },
  ];

  for (const account of accounts) {
    await prisma.ledgerAccount.upsert({
      where: { code: account.code },
      update: { name: account.name, type: account.type, isSystem: true, active: true },
      create: {
        code: account.code,
        name: account.name,
        type: account.type,
        ownerType: 'SYSTEM',
        currency: 'DJF',
        isSystem: true,
      },
    });
  }

  console.log(`✓ ${accounts.length} comptes système`);
}

/**
 * Fournisseur de paiement.
 *
 * RÈGLE ABSOLUE n°8 : aucune fausse intégration. Tant qu'il n'existe pas
 * d'API officielle ET d'accord signé avec un partenaire (D-Money, une banque,
 * un opérateur), seul MOCK existe. On ne crée même pas la ligne des futurs
 * partenaires : une ligne « D-Money INACTIVE » laisserait croire à une
 * intégration en cours.
 */
async function seedPaymentProviders(): Promise<void> {
  await prisma.paymentProvider.upsert({
    where: { code: 'MOCK' },
    update: { status: 'ACTIVE', isSandbox: true },
    create: {
      code: 'MOCK',
      name: 'Fournisseur simulé (bac à sable)',
      status: 'ACTIVE',
      isSandbox: true,
      config: { note: 'Aucune connexion externe. Réponses simulées en mémoire.' },
    },
  });

  console.log('✓ 1 fournisseur de paiement (MOCK)');
}

/**
 * Grille tarifaire.
 *
 * ⚠️ CES MONTANTS SONT DES VALEURS DE DÉPART, PAS UNE DÉCISION COMMERCIALE.
 * Ils existent pour que le moteur de frais (PHASE 6) ait de quoi travailler.
 * La vraie grille se décide avec le métier et se vérifie au regard de la
 * réglementation. Elle se modifie en base, jamais dans le code.
 *
 * PERCENT s'exprime en points de base : 100 bp = 1 %.
 */
async function seedFeeRules(): Promise<void> {
  const rules = [
    {
      name: 'Transfert entre clients',
      transactionType: 'TRANSFER' as const,
      userType: null,
      feeType: 'PERCENT' as const,
      feeValue: 100, // 1 %
      floorMinor: fdj(25), // au moins 25 FDJ
      capMinor: fdj(500), // au plus 500 FDJ : le gros montant n'est pas puni
      minAmountMinor: null,
      maxAmountMinor: null,
    },
    {
      name: 'Dépôt chez un agent',
      transactionType: 'DEPOSIT' as const,
      userType: null,
      feeType: 'FLAT' as const,
      // Gratuit, volontairement : faire entrer l'argent dans le système est
      // ce qui rend le service utile. C'est le retrait qui est facturé.
      feeValue: 0,
      floorMinor: null,
      capMinor: null,
      minAmountMinor: null,
      maxAmountMinor: null,
    },
    {
      name: 'Retrait chez un agent',
      transactionType: 'WITHDRAWAL' as const,
      userType: null,
      feeType: 'PERCENT' as const,
      feeValue: 150, // 1,5 %
      floorMinor: fdj(50),
      capMinor: fdj(1000),
      minAmountMinor: null,
      maxAmountMinor: null,
    },
    {
      name: 'Paiement chez un marchand',
      transactionType: 'MERCHANT_PAYMENT' as const,
      userType: null,
      feeType: 'FLAT' as const,
      // Côté client : gratuit. Le marchand est facturé sur son encaissement.
      feeValue: 0,
      floorMinor: null,
      capMinor: null,
      minAmountMinor: null,
      maxAmountMinor: null,
    },
  ];

  for (const rule of rules) {
    await prisma.feeRule.upsert({
      where: { name_version: { name: rule.name, version: 1 } },
      update: rule,
      create: { ...rule, currency: 'DJF', active: true, version: 1 },
    });
  }

  console.log(`✓ ${rules.length} règles de frais`);
}

/**
 * Plafonds par niveau KYC.
 *
 * ⚠️ VALEURS DE DÉPART ÉGALEMENT. Les plafonds réels relèvent de la
 * réglementation de la Banque Centrale de Djibouti en matière de monnaie
 * électronique et de lutte contre le blanchiment. Ils devront être alignés
 * sur les textes applicables avant tout passage en argent réel.
 *
 * Le principe, lui, ne changera pas : moins un compte est vérifié, moins il
 * peut déplacer d'argent.
 */
async function seedTransactionLimits(): Promise<void> {
  const limits = [
    // Niveau 0 — téléphone vérifié seulement. De quoi essayer, pas plus.
    { kycLevel: 0, period: 'SINGLE' as const, maxAmountMinor: fdj(5_000), maxCount: null },
    { kycLevel: 0, period: 'DAILY' as const, maxAmountMinor: fdj(10_000), maxCount: 5 },
    { kycLevel: 0, period: 'MONTHLY' as const, maxAmountMinor: fdj(50_000), maxCount: 30 },

    // Niveau 1 — identité déclarée et pièce fournie.
    { kycLevel: 1, period: 'SINGLE' as const, maxAmountMinor: fdj(100_000), maxCount: null },
    { kycLevel: 1, period: 'DAILY' as const, maxAmountMinor: fdj(300_000), maxCount: 20 },
    { kycLevel: 1, period: 'MONTHLY' as const, maxAmountMinor: fdj(1_500_000), maxCount: 200 },

    // Niveau 2 — pièce vérifiée par un opérateur.
    { kycLevel: 2, period: 'SINGLE' as const, maxAmountMinor: fdj(500_000), maxCount: null },
    { kycLevel: 2, period: 'DAILY' as const, maxAmountMinor: fdj(2_000_000), maxCount: 50 },
    { kycLevel: 2, period: 'MONTHLY' as const, maxAmountMinor: fdj(10_000_000), maxCount: 500 },
  ];

  for (const limit of limits) {
    // Pas d'upsert ici : la clé unique contient transactionType, qui vaut NULL
    // pour ces règles, et Prisma refuse un NULL dans une clé composite.
    // L'unicité reste garantie en base par l'index partiel
    // transaction_limits_all_types_key.
    const existing = await prisma.transactionLimit.findFirst({
      where: {
        scope: 'USER',
        kycLevel: limit.kycLevel,
        period: limit.period,
        transactionType: null,
      },
    });

    const data = {
      maxAmountMinor: limit.maxAmountMinor,
      maxCount: limit.maxCount,
      active: true,
    };

    if (existing) {
      await prisma.transactionLimit.update({ where: { id: existing.id }, data });
    } else {
      await prisma.transactionLimit.create({
        data: {
          scope: 'USER',
          kycLevel: limit.kycLevel,
          period: limit.period,
          currency: 'DJF',
          ...data,
        },
      });
    }
  }

  console.log(`✓ ${limits.length} plafonds de transaction`);
}

async function main(): Promise<void> {
  console.log('Données de référence 253Pay\n');

  await seedSystemAccounts();
  await seedPaymentProviders();
  await seedFeeRules();
  await seedTransactionLimits();

  // Volontairement, aucun utilisateur de test n'est créé ici. Créer un
  // utilisateur exige de hacher un PIN en Argon2id, ce que définit la PHASE 3 :
  // un faux hachage aujourd'hui serait un mauvais exemple recopié demain.
  console.log('\nTerminé. Aucun utilisateur de test : ils arriveront en PHASE 3.');
}

main()
  .catch((error) => {
    console.error('Échec du seed :', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
