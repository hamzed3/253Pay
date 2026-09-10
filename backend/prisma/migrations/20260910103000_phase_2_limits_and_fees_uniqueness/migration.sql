-- Deux trous d'unicité repérés en écrivant le script de données de référence.

-- ---------------------------------------------------------------------
-- 1. Une règle de frais ne doit exister qu'en un seul exemplaire par version
--
-- Sans cette contrainte, relancer le seed ou une erreur d'administration
-- créait deux règles concurrentes pour le même tarif. Le moteur de frais
-- (PHASE 6) en aurait choisi une au hasard : deux clients auraient payé un
-- prix différent pour la même opération.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX "fee_rules_name_version_key" ON "fee_rules"("name", "version");

-- ---------------------------------------------------------------------
-- 2. Unicité des plafonds « tous types d'opération »
--
-- transaction_limits.transaction_type est nullable, et sous PostgreSQL deux
-- NULL ne sont pas égaux : la contrainte UNIQUE générée par Prisma laisse
-- donc passer autant de lignes « tous types » qu'on veut, pour le même
-- niveau KYC et la même période. Deux plafonds contradictoires sur le même
-- compte, c'est un incident de conformité en puissance.
--
-- Un index unique partiel ferme le trou : Prisma ne sait pas le déclarer,
-- PostgreSQL le fait très bien.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX "transaction_limits_all_types_key"
  ON "transaction_limits" ("scope", "kyc_level", "period")
  WHERE "transaction_type" IS NULL;
