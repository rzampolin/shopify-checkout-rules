-- Migration: full_session_model
--
-- Adds the 7 user-identity columns that @shopify/shopify-app-session-storage-prisma
-- writes unconditionally on every session upsert.  The init migration created the
-- Session table without them, causing PrismaClientValidationError on "Unknown
-- argument `firstName`" (and the other 6 fields).
--
-- HOW TO APPLY:
--   Development:  npx prisma migrate dev --name full-session-model
--   Production:   npx prisma migrate deploy
--   After either: npx prisma generate   (regenerates the Prisma client)
--
-- NOTE: SQLite does not support adding NOT NULL columns without a default in a
-- single ALTER TABLE, so all new columns are nullable — which matches the Prisma
-- model (all Boolean? / String?).

ALTER TABLE "Session" ADD COLUMN "firstName"     TEXT;
ALTER TABLE "Session" ADD COLUMN "lastName"      TEXT;
ALTER TABLE "Session" ADD COLUMN "email"         TEXT;
ALTER TABLE "Session" ADD COLUMN "accountOwner"  BOOLEAN;
ALTER TABLE "Session" ADD COLUMN "locale"        TEXT;
ALTER TABLE "Session" ADD COLUMN "collaborator"  BOOLEAN;
ALTER TABLE "Session" ADD COLUMN "emailVerified" BOOLEAN;
