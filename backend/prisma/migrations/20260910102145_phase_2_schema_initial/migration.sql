-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'AGENT', 'MERCHANT', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'BLOCKED', 'CLOSED');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('ANDROID', 'IOS', 'WEB');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('REGISTRATION', 'LOGIN', 'TRANSACTION', 'PIN_RESET');

-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "LedgerOwnerType" AS ENUM ('USER', 'AGENT', 'MERCHANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE', 'EQUITY');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'MERCHANT_PAYMENT', 'COMMISSION', 'FEE', 'REVERSAL');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REVERSED');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MerchantUserRole" AS ENUM ('OWNER', 'CASHIER');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('FLAT', 'PERCENT', 'TIERED');

-- CreateEnum
CREATE TYPE "LimitScope" AS ENUM ('USER', 'AGENT', 'MERCHANT');

-- CreateEnum
CREATE TYPE "LimitPeriod" AS ENUM ('SINGLE', 'DAILY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "KycDocumentType" AS ENUM ('NATIONAL_ID', 'PASSPORT', 'RESIDENCE_PERMIT', 'DRIVING_LICENSE');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('TRANSACTION', 'SECURITY', 'KYC', 'PROMOTION', 'SYSTEM');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "email" VARCHAR(255),
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "pin_hash" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255),
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "kyc_level" SMALLINT NOT NULL DEFAULT 0,
    "phone_verified_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "failed_pin_attempts" INTEGER NOT NULL DEFAULT 0,
    "blocked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "birth_date" DATE,
    "address" VARCHAR(255),
    "city" VARCHAR(100),
    "nationality" VARCHAR(100),
    "photo_url" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" VARCHAR(255) NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "model" VARCHAR(120),
    "fcm_token" VARCHAR(500),
    "trusted" BOOLEAN NOT NULL DEFAULT false,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "device_id" VARCHAR(255),
    "replaced_by_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otps" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "code_hash" VARCHAR(255) NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "ip" VARCHAR(45),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'DJF',
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "available_minor" BIGINT NOT NULL DEFAULT 0,
    "reserved_minor" BIGINT NOT NULL DEFAULT 0,
    "ledger_account_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "owner_type" "LedgerOwnerType" NOT NULL,
    "owner_id" UUID,
    "type" "LedgerAccountType" NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'DJF',
    "name" VARCHAR(150) NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "balance_after_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'DJF',
    "description" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(40) NOT NULL,
    "type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "amount_minor" BIGINT NOT NULL,
    "fee_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'DJF',
    "initiator_id" UUID NOT NULL,
    "source_wallet_id" UUID,
    "destination_wallet_id" UUID,
    "provider_id" UUID,
    "provider_reference" VARCHAR(120),
    "idempotency_key" VARCHAR(100),
    "reversal_of_id" UUID,
    "metadata" JSONB,
    "failure_reason" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "agent_code" VARCHAR(20) NOT NULL,
    "float_wallet_id" UUID NOT NULL,
    "business_name" VARCHAR(150),
    "zone" VARCHAR(100),
    "commission_rate_bp" INTEGER NOT NULL DEFAULT 0,
    "status" "AgentStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchants" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "merchant_code" VARCHAR(20) NOT NULL,
    "category" VARCHAR(80),
    "wallet_id" UUID NOT NULL,
    "qr_payload" VARCHAR(500),
    "status" "MerchantStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_users" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "MerchantUserRole" NOT NULL DEFAULT 'CASHIER',
    "permissions" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commissions" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'DJF',
    "rule_id" UUID,
    "status" "CommissionStatus" NOT NULL DEFAULT 'PENDING',
    "paid_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_rules" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "transaction_type" "TransactionType" NOT NULL,
    "user_type" "UserRole",
    "min_amount_minor" BIGINT,
    "max_amount_minor" BIGINT,
    "fee_type" "FeeType" NOT NULL,
    "fee_value" INTEGER NOT NULL,
    "cap_minor" BIGINT,
    "floor_minor" BIGINT,
    "tiers" JSONB,
    "currency" CHAR(3) NOT NULL DEFAULT 'DJF',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fee_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_limits" (
    "id" UUID NOT NULL,
    "scope" "LimitScope" NOT NULL,
    "kyc_level" SMALLINT NOT NULL,
    "period" "LimitPeriod" NOT NULL,
    "transaction_type" "TransactionType",
    "max_amount_minor" BIGINT NOT NULL,
    "max_count" INTEGER,
    "currency" CHAR(3) NOT NULL DEFAULT 'DJF',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "transaction_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_providers" (
    "id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" "ProviderStatus" NOT NULL DEFAULT 'INACTIVE',
    "is_sandbox" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_verifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "level" SMALLINT NOT NULL,
    "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "document_type" "KycDocumentType" NOT NULL,
    "document_number_hash" VARCHAR(255) NOT NULL,
    "document_url" VARCHAR(500),
    "selfie_url" VARCHAR(500),
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "rejection_reason" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "kyc_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider_id" UUID,
    "event_type" VARCHAR(80) NOT NULL,
    "external_id" VARCHAR(180) NOT NULL,
    "signature_valid" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_role" "UserRole",
    "action" VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(80) NOT NULL,
    "entity_id" VARCHAR(80),
    "before" JSONB,
    "after" JSONB,
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(255),
    "reason" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "body" VARCHAR(500) NOT NULL,
    "data" JSONB,
    "read_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_user_id_key" ON "user_profiles"("user_id");

-- CreateIndex
CREATE INDEX "devices_user_id_idx" ON "devices"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_user_id_device_id_key" ON "devices"("user_id", "device_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_replaced_by_id_key" ON "refresh_tokens"("replaced_by_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_revoked_at_idx" ON "refresh_tokens"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "otps_phone_created_at_idx" ON "otps"("phone", "created_at" DESC);

-- CreateIndex
CREATE INDEX "otps_expires_at_idx" ON "otps"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_ledger_account_id_key" ON "wallets"("ledger_account_id");

-- CreateIndex
CREATE INDEX "wallets_status_idx" ON "wallets"("status");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_user_id_currency_key" ON "wallets"("user_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_code_key" ON "ledger_accounts"("code");

-- CreateIndex
CREATE INDEX "ledger_accounts_owner_type_owner_id_idx" ON "ledger_accounts"("owner_type", "owner_id");

-- CreateIndex
CREATE INDEX "ledger_accounts_type_idx" ON "ledger_accounts"("type");

-- CreateIndex
CREATE INDEX "ledger_entries_account_id_created_at_idx" ON "ledger_entries"("account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_reference_key" ON "transactions"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_idempotency_key_key" ON "transactions"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_reversal_of_id_key" ON "transactions"("reversal_of_id");

-- CreateIndex
CREATE INDEX "transactions_initiator_id_created_at_idx" ON "transactions"("initiator_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "transactions_source_wallet_id_created_at_idx" ON "transactions"("source_wallet_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "transactions_destination_wallet_id_created_at_idx" ON "transactions"("destination_wallet_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "transactions_type_status_idx" ON "transactions"("type", "status");

-- CreateIndex
CREATE INDEX "transactions_provider_reference_idx" ON "transactions"("provider_reference");

-- CreateIndex
CREATE UNIQUE INDEX "agents_user_id_key" ON "agents"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "agents_agent_code_key" ON "agents"("agent_code");

-- CreateIndex
CREATE UNIQUE INDEX "agents_float_wallet_id_key" ON "agents"("float_wallet_id");

-- CreateIndex
CREATE INDEX "agents_status_idx" ON "agents"("status");

-- CreateIndex
CREATE INDEX "agents_zone_idx" ON "agents"("zone");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_merchant_code_key" ON "merchants"("merchant_code");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_wallet_id_key" ON "merchants"("wallet_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_qr_payload_key" ON "merchants"("qr_payload");

-- CreateIndex
CREATE INDEX "merchants_status_idx" ON "merchants"("status");

-- CreateIndex
CREATE INDEX "merchant_users_user_id_idx" ON "merchant_users"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_users_merchant_id_user_id_key" ON "merchant_users"("merchant_id", "user_id");

-- CreateIndex
CREATE INDEX "commissions_agent_id_status_idx" ON "commissions"("agent_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "commissions_transaction_id_agent_id_key" ON "commissions"("transaction_id", "agent_id");

-- CreateIndex
CREATE INDEX "fee_rules_transaction_type_active_idx" ON "fee_rules"("transaction_type", "active");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_limits_scope_kyc_level_period_transaction_type_key" ON "transaction_limits"("scope", "kyc_level", "period", "transaction_type");

-- CreateIndex
CREATE UNIQUE INDEX "payment_providers_code_key" ON "payment_providers"("code");

-- CreateIndex
CREATE INDEX "kyc_verifications_user_id_created_at_idx" ON "kyc_verifications"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "kyc_verifications_status_idx" ON "kyc_verifications"("status");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_verifications_document_type_document_number_hash_key" ON "kyc_verifications"("document_type", "document_number_hash");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_external_id_key" ON "webhook_events"("external_id");

-- CreateIndex
CREATE INDEX "webhook_events_processed_at_idx" ON "webhook_events"("processed_at");

-- CreateIndex
CREATE INDEX "webhook_events_event_type_created_at_idx" ON "webhook_events"("event_type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_ledger_account_id_fkey" FOREIGN KEY ("ledger_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_initiator_id_fkey" FOREIGN KEY ("initiator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_wallet_id_fkey" FOREIGN KEY ("source_wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_destination_wallet_id_fkey" FOREIGN KEY ("destination_wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_float_wallet_id_fkey" FOREIGN KEY ("float_wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_users" ADD CONSTRAINT "merchant_users_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_users" ADD CONSTRAINT "merchant_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_verifications" ADD CONSTRAINT "kyc_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- GARANTIES ÉCRITES À LA MAIN
--
-- Tout ce qui suit ne peut pas être exprimé dans schema.prisma. Ce sont
-- pourtant les règles les plus importantes du projet : elles transforment
-- des conventions d'équipe en lois que PostgreSQL fait respecter, même
-- devant une requête manuelle lancée en production à 2h du matin.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Contraintes de montant
--
-- Risque n°1 du document d'architecture : la double dépense. Le verrou
-- SELECT ... FOR UPDATE (PHASE 4) est la première parade ; cette contrainte
-- est le filet de sécurité. Si un bug applicatif tente de faire passer un
-- solde sous zéro, la transaction PostgreSQL entière est annulée.
-- ---------------------------------------------------------------------
ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_available_not_negative" CHECK ("available_minor" >= 0),
  ADD CONSTRAINT "wallets_reserved_not_negative"  CHECK ("reserved_minor" >= 0);

-- Le sens d'une écriture est porté par `direction`, jamais par le signe du
-- montant. Un montant négatif rendrait toute somme ambiguë.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_strictly_positive" CHECK ("amount_minor" > 0);

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_amount_not_negative" CHECK ("amount_minor" >= 0),
  ADD CONSTRAINT "transactions_fee_not_negative"    CHECK ("fee_minor" >= 0);

ALTER TABLE "commissions"
  ADD CONSTRAINT "commissions_amount_not_negative" CHECK ("amount_minor" >= 0);

ALTER TABLE "users"
  ADD CONSTRAINT "users_kyc_level_range" CHECK ("kyc_level" BETWEEN 0 AND 2);

-- Un taux se lit en points de base : 10000 bp = 100 %. Au-delà, c'est un bug.
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_commission_rate_range" CHECK ("commission_rate_bp" BETWEEN 0 AND 10000);

ALTER TABLE "fee_rules"
  ADD CONSTRAINT "fee_rules_value_not_negative" CHECK ("fee_value" >= 0),
  ADD CONSTRAINT "fee_rules_bounds_ordered" CHECK (
    "min_amount_minor" IS NULL
    OR "max_amount_minor" IS NULL
    OR "min_amount_minor" <= "max_amount_minor"
  );

ALTER TABLE "transaction_limits"
  ADD CONSTRAINT "transaction_limits_max_not_negative" CHECK ("max_amount_minor" >= 0);

-- ---------------------------------------------------------------------
-- 2. Cohérence d'une transaction
-- ---------------------------------------------------------------------

-- Un virement sur soi-même n'est pas un virement : c'est un bug ou un abus.
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_source_differs_from_destination" CHECK (
    "source_wallet_id" IS NULL
    OR "destination_wallet_id" IS NULL
    OR "source_wallet_id" <> "destination_wallet_id"
  );

-- Une annulation pointe TOUJOURS vers la transaction annulée, et seule une
-- annulation le fait. C'est ce qui rend l'historique lisible par un auditeur.
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_reversal_coherent" CHECK (
    ("type" = 'REVERSAL' AND "reversal_of_id" IS NOT NULL)
    OR ("type" <> 'REVERSAL' AND "reversal_of_id" IS NULL)
  );

-- Une transaction terminée porte une date de fin, et une seule fois.
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_completed_at_coherent" CHECK (
    ("status" IN ('COMPLETED', 'REVERSED') AND "completed_at" IS NOT NULL)
    OR ("status" NOT IN ('COMPLETED', 'REVERSED'))
  );

-- ---------------------------------------------------------------------
-- 3. Index partiel sur les transactions en cours
--
-- La tâche de reprise (PHASE 13) cherche « les transactions bloquées ».
-- Elles sont une poignée parmi des millions de lignes terminées : un index
-- partiel ne contient que celles-là. Il reste minuscule et donc en mémoire.
-- ---------------------------------------------------------------------
CREATE INDEX "transactions_status_in_flight_idx"
  ON "transactions" ("status", "created_at")
  WHERE "status" IN ('PENDING', 'PROCESSING');

-- ---------------------------------------------------------------------
-- 4. Le ledger est en lecture seule après écriture
--
-- Règle absolue n°4 du projet. Sans ce déclencheur, la règle n'est qu'un
-- commentaire : n'importe quel UPDATE mal écrit, ou un accès direct à la
-- base, pourrait réécrire l'histoire comptable sans laisser de trace.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "ledger_entries_immutable"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'LEDGER_IMMUTABLE: une écriture comptable ne peut être ni modifiée ni supprimée (tentative de % sur ledger_entries)',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_entries_no_update"
  BEFORE UPDATE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_immutable"();

CREATE TRIGGER "ledger_entries_no_delete"
  BEFORE DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_immutable"();

-- ---------------------------------------------------------------------
-- 5. Une transaction ne se supprime jamais, et ne se modifie plus une fois
--    terminée
--
-- Seule évolution autorisée après COMPLETED : passer à REVERSED, ce que fait
-- la transaction d'annulation. Les montants, eux, sont figés pour toujours.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "transactions_no_delete"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'TRANSACTION_IMMUTABLE: une transaction financière ne se supprime jamais (id %). Créez une transaction REVERSAL.',
    OLD."id"
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "transactions_block_delete"
  BEFORE DELETE ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION "transactions_no_delete"();

CREATE OR REPLACE FUNCTION "transactions_frozen_when_completed"() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" <> 'COMPLETED' THEN
    RETURN NEW;
  END IF;

  -- Après COMPLETED, la seule transition permise est REVERSED.
  IF NEW."status" NOT IN ('COMPLETED', 'REVERSED') THEN
    RAISE EXCEPTION
      'TRANSACTION_IMMUTABLE: une transaction COMPLETED ne peut pas repasser à % (id %)',
      NEW."status", OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Et les données financières restent figées, quel que soit le statut.
  IF NEW."amount_minor" <> OLD."amount_minor"
     OR NEW."fee_minor" <> OLD."fee_minor"
     OR NEW."currency" <> OLD."currency"
     OR NEW."type" <> OLD."type"
     OR NEW."source_wallet_id" IS DISTINCT FROM OLD."source_wallet_id"
     OR NEW."destination_wallet_id" IS DISTINCT FROM OLD."destination_wallet_id"
  THEN
    RAISE EXCEPTION
      'TRANSACTION_IMMUTABLE: les montants et portefeuilles d''une transaction COMPLETED sont figés (id %)',
      OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "transactions_freeze_completed"
  BEFORE UPDATE ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION "transactions_frozen_when_completed"();

-- ---------------------------------------------------------------------
-- 6. L'équilibre du ledger, vérifié par PostgreSQL
--
-- Règle absolue n°2 : tout mouvement d'argent est un débit + un crédit
-- équilibrés. Ce déclencheur est DEFERRABLE INITIALLY DEFERRED : il ne se
-- déclenche pas à chaque INSERT (les écritures arrivent forcément une par
-- une, donc temporairement déséquilibrées) mais au moment du COMMIT.
--
-- Conséquence concrète : il devient IMPOSSIBLE de valider une transaction
-- dont les débits ne totalisent pas exactement les crédits. Un bug de calcul
-- de frais ne peut plus faire disparaître de l'argent en silence — il fait
-- échouer la transaction, bruyamment, avant tout dégât.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "assert_ledger_balanced"() RETURNS TRIGGER AS $$
DECLARE
  v_debit  BIGINT;
  v_credit BIGINT;
BEGIN
  SELECT
    COALESCE(SUM("amount_minor") FILTER (WHERE "direction" = 'DEBIT'), 0),
    COALESCE(SUM("amount_minor") FILTER (WHERE "direction" = 'CREDIT'), 0)
  INTO v_debit, v_credit
  FROM "ledger_entries"
  WHERE "transaction_id" = NEW."transaction_id";

  IF v_debit <> v_credit THEN
    RAISE EXCEPTION
      'LEDGER_UNBALANCED: transaction % — débits % ≠ crédits %',
      NEW."transaction_id", v_debit, v_credit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ledger_entries_must_balance"
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "assert_ledger_balanced"();
