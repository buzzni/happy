CREATE TYPE "AutomationRunKind" AS ENUM ('SCHEDULED', 'QUESTION');
ALTER TABLE "AutomationRun" ADD COLUMN "kind" "AutomationRunKind" NOT NULL DEFAULT 'SCHEDULED';
DROP INDEX "AutomationRun_automationId_generation_scheduledFor_key";
CREATE UNIQUE INDEX "AutomationRun_automationId_generation_scheduledFor_key"
    ON "AutomationRun"("automationId", "generation", "scheduledFor") WHERE "kind" = 'SCHEDULED';
CREATE INDEX "AutomationRun_automationId_generation_scheduledFor_idx"
    ON "AutomationRun"("automationId", "generation", "scheduledFor");
