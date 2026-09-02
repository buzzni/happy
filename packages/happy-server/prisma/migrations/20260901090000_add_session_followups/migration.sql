CREATE TYPE "SessionFollowupStatus" AS ENUM (
    'WAITING', 'DELIVERY_PENDING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED'
);

CREATE TYPE "SessionFollowupTerminalCode" AS ENUM (
    'CLEAN', 'LOW_OR_NIT_ONLY', 'UNSTRUCTURED', 'ROUNDS_EXHAUSTED',
    'USER_INTERVENTION', 'STOPPED', 'SESSION_UNAVAILABLE',
    'TARGET_MISMATCH', 'DECRYPT_FAILED', 'PERMISSION_REVOKED'
);

CREATE TYPE "SessionFollowupChangeKind" AS ENUM ('UPSERT', 'TOMBSTONE');

CREATE TYPE "SessionFollowupHistoryKind" AS ENUM (
    'STARTED', 'CONTINUATION_RESERVED', 'CONTINUATION_DELIVERED',
    'TERMINATED', 'PAUSED', 'RESUMED', 'STOPPED', 'DELETED'
);

CREATE TABLE "SessionFollowup" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ownerAccountId" TEXT NOT NULL,
    "machineAccountId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "step" INTEGER NOT NULL DEFAULT 1,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "payloadCiphertext" BYTEA NOT NULL,
    "viewerKeyId" TEXT NOT NULL,
    "viewerKeyVersion" INTEGER NOT NULL,
    "viewerKeyEnvelope" BYTEA NOT NULL,
    "machineKeyVersion" INTEGER NOT NULL,
    "machineKeyEnvelope" BYTEA NOT NULL,
    "status" "SessionFollowupStatus" NOT NULL DEFAULT 'WAITING',
    "terminalCode" "SessionFollowupTerminalCode",
    "totalRounds" INTEGER NOT NULL,
    "currentRound" INTEGER NOT NULL,
    "responseBoundarySeq" INTEGER NOT NULL,
    "lastObservedSeq" INTEGER NOT NULL,
    "pendingExpectedSeq" INTEGER,
    "pendingLocalId" TEXT,
    "claimTokenHash" BYTEA,
    "claimExpiresAt" TIMESTAMP(3),
    "claimedGeneration" INTEGER,
    "claimedStep" INTEGER,
    "deletedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SessionFollowup_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SessionFollowup_rounds_check" CHECK (
        "totalRounds" BETWEEN 2 AND 7
        AND "currentRound" BETWEEN 1 AND "totalRounds"
    )
);

CREATE TABLE "SessionFollowupChange" (
    "seq" BIGSERIAL NOT NULL,
    "followupId" TEXT NOT NULL,
    "machineAccountId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL,
    "kind" "SessionFollowupChangeKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionFollowupChange_pkey" PRIMARY KEY ("seq")
);

CREATE TABLE "SessionFollowupHistory" (
    "id" TEXT NOT NULL,
    "followupId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "step" INTEGER NOT NULL,
    "round" INTEGER NOT NULL,
    "kind" "SessionFollowupHistoryKind" NOT NULL,
    "terminalCode" "SessionFollowupTerminalCode",
    "observedSeq" INTEGER,
    "detailCiphertext" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionFollowupHistory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SessionFollowup_pendingLocalId_key" ON "SessionFollowup"("pendingLocalId");
CREATE UNIQUE INDEX "SessionFollowup_claimTokenHash_key" ON "SessionFollowup"("claimTokenHash");
CREATE UNIQUE INDEX "SessionFollowup_one_active_per_session" ON "SessionFollowup"("sessionId")
    WHERE "deletedAt" IS NULL AND "status" IN ('WAITING', 'DELIVERY_PENDING', 'PAUSED');
CREATE INDEX "SessionFollowup_projectId_sessionId_deletedAt_idx" ON "SessionFollowup"("projectId", "sessionId", "deletedAt");
CREATE INDEX "SessionFollowup_machineAccountId_machineId_status_deletedAt_idx" ON "SessionFollowup"("machineAccountId", "machineId", "status", "deletedAt");
CREATE UNIQUE INDEX "SessionFollowupChange_followupId_revision_machineAccountId_machineId_kind_key" ON "SessionFollowupChange"("followupId", "revision", "machineAccountId", "machineId", "kind");
CREATE INDEX "SessionFollowupChange_machineAccountId_machineId_seq_idx" ON "SessionFollowupChange"("machineAccountId", "machineId", "seq");
CREATE INDEX "SessionFollowupChange_followupId_idx" ON "SessionFollowupChange"("followupId");
CREATE INDEX "SessionFollowupHistory_followupId_createdAt_idx" ON "SessionFollowupHistory"("followupId", "createdAt" DESC);

ALTER TABLE "SessionFollowup" ADD CONSTRAINT "SessionFollowup_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionFollowup" ADD CONSTRAINT "SessionFollowup_ownerAccountId_fkey"
    FOREIGN KEY ("ownerAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SessionFollowupHistory" ADD CONSTRAINT "SessionFollowupHistory_followupId_fkey"
    FOREIGN KEY ("followupId") REFERENCES "SessionFollowup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
