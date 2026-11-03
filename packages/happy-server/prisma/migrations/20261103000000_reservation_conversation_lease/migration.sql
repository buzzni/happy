ALTER TYPE "AutomationRunOutcome" ADD VALUE 'NO_CHANGE';

CREATE TYPE "ReservationConversationLeaseState" AS ENUM ('PREPARING', 'RUNNING', 'SETTLING');
CREATE TABLE "ReservationConversationLease" (
    "sessionId" TEXT NOT NULL, "runId" TEXT NOT NULL, "automationId" TEXT NOT NULL, "generation" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL, "machineId" TEXT NOT NULL, "claimTokenHash" BYTEA NOT NULL,
    "epoch" TEXT NOT NULL, "state" "ReservationConversationLeaseState" NOT NULL, "descriptorHash" TEXT NOT NULL, "messageCapabilityHash" BYTEA NOT NULL,
    "launchId" TEXT, "processGroupId" INTEGER, "processStartId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "expectedSeq" INTEGER NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReservationConversationLease_pkey" PRIMARY KEY ("sessionId")
);
CREATE UNIQUE INDEX "ReservationConversationLease_runId_key" ON "ReservationConversationLease"("runId");
CREATE UNIQUE INDEX "ReservationConversationLease_epoch_key" ON "ReservationConversationLease"("epoch");
CREATE INDEX "ReservationConversationLease_accountId_machineId_idx" ON "ReservationConversationLease"("accountId", "machineId");
ALTER TABLE "ReservationConversationLease" ADD CONSTRAINT "ReservationConversationLease_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ReservationCheckpoint" (
    "automationId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReservationCheckpoint_pkey" PRIMARY KEY ("automationId")
);
ALTER TABLE "ReservationCheckpoint" ADD CONSTRAINT "ReservationCheckpoint_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
