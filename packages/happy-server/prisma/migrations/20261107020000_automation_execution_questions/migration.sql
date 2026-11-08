CREATE TABLE "AutomationExecutionQuestion" (
    "id" TEXT NOT NULL,
    "requestedByAccountId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "sourceRunId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "displaySessionId" TEXT NOT NULL,
    "machineAccountId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "encrypted" JSONB NOT NULL,
    "requestHash" TEXT NOT NULL,
    "runId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutomationExecutionQuestion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AutomationExecutionQuestion_runId_key" ON "AutomationExecutionQuestion"("runId");
CREATE INDEX "AutomationExecutionQuestion_machine_fifo"
    ON "AutomationExecutionQuestion"("machineAccountId", "machineId", "createdAt", "id");
ALTER TABLE "AutomationExecutionQuestion" ADD CONSTRAINT "AutomationExecutionQuestion_automationId_fkey"
    FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
