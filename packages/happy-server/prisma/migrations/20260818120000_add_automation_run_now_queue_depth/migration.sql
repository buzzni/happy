ALTER TABLE "Machine" ADD COLUMN "automationProtocolVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Automation" ADD COLUMN "runRequestedAt" TIMESTAMP(3);
ALTER TABLE "AutomationRun" ADD COLUMN "queueDepth" INTEGER;
