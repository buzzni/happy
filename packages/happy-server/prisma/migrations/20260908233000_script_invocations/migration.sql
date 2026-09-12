ALTER TABLE "Automation" ADD COLUMN "scriptRegistrationKey" TEXT;
CREATE UNIQUE INDEX "Automation_projectId_scriptRegistrationKey_key" ON "Automation" ("projectId", "scriptRegistrationKey");
CREATE TABLE "ScriptArtifact" (
    "id" TEXT PRIMARY KEY,
    "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "digest" TEXT NOT NULL,
    "encrypted" JSONB NOT NULL
);
CREATE TABLE "ScriptAutomationRevision" (
    "automationId" TEXT NOT NULL REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "revision" INTEGER NOT NULL,
    "artifactId" TEXT NOT NULL REFERENCES "ScriptArtifact"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
    "digest" TEXT NOT NULL,
    "payloadCiphertext" TEXT NOT NULL,
    "admission" JSONB NOT NULL,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "nextRunAt" DOUBLE PRECISION,
    "scheduleInitialized" BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY ("automationId", "revision")
);

CREATE TABLE "ScriptAutomationKeyEpoch" (
    "id" TEXT PRIMARY KEY,
    "automationId" TEXT NOT NULL REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "epoch" INTEGER NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" DOUBLE PRECISION NOT NULL,
    "rateWindow" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rateCount" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE "ScriptInvocation" (
    "id" TEXT PRIMARY KEY,
    "automationId" TEXT NOT NULL REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "revision" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL CHECK ("trigger" IN ('API','MANUAL','SCHEDULE')),
    "requestedBy" TEXT NOT NULL,
    "keyId" TEXT,
    "keyEpoch" INTEGER,
    "idempotencyKey" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "inputCiphertext" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED'
      CHECK ("status" IN ('QUEUED','CLAIMED','RUNNING','COMPLETED','FAILED','CANCELLED','EXPIRED','UNKNOWN')),
    "claimHash" TEXT,
    "leaseExpiresAt" DOUBLE PRECISION,
    "createdAt" DOUBLE PRECISION NOT NULL,
    "startedAt" DOUBLE PRECISION,
    "completedAt" DOUBLE PRECISION,
    "exitCode" INTEGER,
    "failureCode" TEXT,
    "logCiphertext" TEXT,
    "cancelRequestedAt" DOUBLE PRECISION,
    "scheduledFor" DOUBLE PRECISION,
    "missedCount" INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY ("automationId", "revision") REFERENCES "ScriptAutomationRevision"("automationId", "revision") ON DELETE NO ACTION ON UPDATE CASCADE,
    UNIQUE ("automationId", "requestedBy", "idempotencyKey")
);
CREATE INDEX "ScriptInvocation_fifo" ON "ScriptInvocation" ("automationId", "status", "createdAt", "id");
CREATE UNIQUE INDEX "ScriptInvocation_active" ON "ScriptInvocation" ("automationId") WHERE "status" IN ('CLAIMED', 'RUNNING');

ALTER TABLE "ScriptAutomationRevision" ADD COLUMN "validationFailure" TEXT;
