ALTER TABLE "Automation"
    ADD COLUMN "legacyMigrationPending" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "legacyDesiredPaused" BOOLEAN;
