ALTER TABLE "AutomationRun" ADD COLUMN "displaySessionId" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "executionCreateBodyHash" TEXT;
CREATE INDEX "AutomationRun_displaySessionId_createdAt_idx" ON "AutomationRun"("displaySessionId", "createdAt");
