-- CreateEnum
CREATE TYPE "AutomationChangeKind" AS ENUM ('UPSERT', 'TOMBSTONE');

-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "AutomationRunOutcome" AS ENUM ('WOKE', 'SILENT', 'SKIPPED_GATE', 'ERROR');

-- AlterTable
ALTER TABLE "Project"
    ADD COLUMN "automationViewerPublicKey" BYTEA,
    ADD COLUMN "automationViewerKeyVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Machine"
    ADD COLUMN "automationPublicKey" BYTEA,
    ADD COLUMN "automationKeyVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Automation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ownerAccountId" TEXT NOT NULL,
    "machineAccountId" TEXT,
    "machineId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "payloadCiphertext" BYTEA NOT NULL,
    "viewerKeyId" TEXT NOT NULL,
    "viewerKeyVersion" INTEGER NOT NULL,
    "viewerKeyEnvelope" BYTEA NOT NULL,
    "machineKeyVersion" INTEGER NOT NULL,
    "machineKeyEnvelope" BYTEA NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "appliedRevision" INTEGER NOT NULL DEFAULT 0,
    "appliedAt" TIMESTAMP(3),
    "legacyMachineId" TEXT,
    "legacyAutomationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationChange" (
    "seq" BIGSERIAL NOT NULL,
    "automationId" TEXT NOT NULL,
    "machineAccountId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL,
    "kind" "AutomationChangeKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationChange_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "machineAccountId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "status" "AutomationRunStatus" NOT NULL,
    "claimTokenHash" BYTEA NOT NULL,
    "claimExpiresAt" TIMESTAMP(3) NOT NULL,
    "runLeaseExpiresAt" TIMESTAMP(3),
    "reportId" TEXT,
    "sessionId" TEXT,
    "outcome" "AutomationRunOutcome",
    "detailCiphertext" BYTEA,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lateReport" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Automation_legacyMachineId_legacyAutomationId_key" ON "Automation"("legacyMachineId", "legacyAutomationId");
CREATE INDEX "Automation_projectId_deletedAt_idx" ON "Automation"("projectId", "deletedAt");
CREATE INDEX "Automation_ownerAccountId_idx" ON "Automation"("ownerAccountId");
CREATE INDEX "Automation_machineAccountId_machineId_deletedAt_idx" ON "Automation"("machineAccountId", "machineId", "deletedAt");
CREATE UNIQUE INDEX "AutomationChange_automationId_revision_machineAccountId_machineId_kind_key" ON "AutomationChange"("automationId", "revision", "machineAccountId", "machineId", "kind");
CREATE INDEX "AutomationChange_machineAccountId_machineId_seq_idx" ON "AutomationChange"("machineAccountId", "machineId", "seq");
CREATE INDEX "AutomationChange_automationId_idx" ON "AutomationChange"("automationId");
CREATE UNIQUE INDEX "AutomationRun_claimTokenHash_key" ON "AutomationRun"("claimTokenHash");
CREATE UNIQUE INDEX "AutomationRun_reportId_key" ON "AutomationRun"("reportId");
CREATE UNIQUE INDEX "AutomationRun_automationId_generation_scheduledFor_key" ON "AutomationRun"("automationId", "generation", "scheduledFor");
CREATE UNIQUE INDEX "AutomationRun_one_active_run_per_automation" ON "AutomationRun"("automationId") WHERE "status" IN ('CLAIMED', 'RUNNING');
CREATE INDEX "AutomationRun_automationId_status_idx" ON "AutomationRun"("automationId", "status");
CREATE INDEX "AutomationRun_machineAccountId_machineId_status_idx" ON "AutomationRun"("machineAccountId", "machineId", "status");

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_ownerAccountId_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_machineAccountId_machineId_fkey" FOREIGN KEY ("machineAccountId", "machineId") REFERENCES "Machine"("accountId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
