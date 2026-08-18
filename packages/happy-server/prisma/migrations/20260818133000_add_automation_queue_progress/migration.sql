ALTER TABLE "AutomationRun"
    ADD COLUMN "queuePosition" INTEGER,
    ADD COLUMN "queueTotal" INTEGER,
    ADD COLUMN "queueEstimatedAt" TIMESTAMP(3);
