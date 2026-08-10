-- Explicit canary rollback. Prisma does not execute down migrations automatically.
DROP TABLE "AutomationRun";
DROP TABLE "AutomationChange";
DROP TABLE "Automation";

ALTER TABLE "Machine"
    DROP COLUMN "automationKeyVersion",
    DROP COLUMN "automationPublicKey";

ALTER TABLE "Project"
    DROP COLUMN "automationViewerKeyVersion",
    DROP COLUMN "automationViewerPublicKey";

DROP TYPE "AutomationRunOutcome";
DROP TYPE "AutomationRunStatus";
DROP TYPE "AutomationChangeKind";
