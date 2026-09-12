-- AlterTable
ALTER TABLE "SessionEvent"
ADD COLUMN "checkpoint" JSONB,
ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SessionEvent_sessionId_idempotencyKey_key"
ON "SessionEvent"("sessionId", "idempotencyKey");
