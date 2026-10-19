-- CreateTable
CREATE TABLE "SessionExecutionBinding" (
    "sessionId" TEXT NOT NULL,
    "sessionRowId" TEXT,
    "sessionRowOwnerAccountId" TEXT,
    "companyId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "machineOwnerAccountId" TEXT NOT NULL,
    "machineRowId" TEXT,
    "machineRowOwnerAccountId" TEXT,
    "sessionOwnerAccountId" TEXT NOT NULL,
    "launchId" TEXT NOT NULL,
    "initialNonce" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "deviceKeyId" TEXT NOT NULL,
    "sessionTagHash" TEXT NOT NULL,
    "sessionCreateBodyHash" TEXT NOT NULL,
    "ticketDigest" TEXT NOT NULL,
    "createProofDigest" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionExecutionBinding_pkey" PRIMARY KEY ("sessionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionExecutionBinding_sessionRowId_key" ON "SessionExecutionBinding"("sessionRowId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionExecutionBinding_sessionRowId_sessionRowOwnerAccount_key" ON "SessionExecutionBinding"("sessionRowId", "sessionRowOwnerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionExecutionBinding_companyId_machineId_launchId_key" ON "SessionExecutionBinding"("companyId", "machineId", "launchId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionExecutionBinding_companyId_initialNonce_key" ON "SessionExecutionBinding"("companyId", "initialNonce");

-- CreateIndex
CREATE UNIQUE INDEX "SessionExecutionBinding_companyId_machineId_operationId_key" ON "SessionExecutionBinding"("companyId", "machineId", "operationId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_id_accountId_key" ON "Session"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Machine_id_accountId_key" ON "Machine"("id", "accountId");

-- AddForeignKey
ALTER TABLE "SessionExecutionBinding" ADD CONSTRAINT "SessionExecutionBinding_sessionRowId_sessionRowOwnerAccoun_fkey" FOREIGN KEY ("sessionRowId", "sessionRowOwnerAccountId") REFERENCES "Session"("id", "accountId") ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SessionExecutionBinding" ADD CONSTRAINT "SessionExecutionBinding_machineRowId_machineRowOwnerAccoun_fkey" FOREIGN KEY ("machineRowId", "machineRowOwnerAccountId") REFERENCES "Machine"("id", "accountId") ON DELETE SET NULL ON UPDATE RESTRICT;


-- Preserve immutable identity while allowing normal deletion to null row links.
ALTER TABLE "SessionExecutionBinding"
ADD CONSTRAINT "SessionExecutionBinding_session_identity_check" CHECK (
    ("sessionRowId" IS NULL AND "sessionRowOwnerAccountId" IS NULL) OR
    ("sessionRowId" IS NOT NULL AND "sessionRowOwnerAccountId" IS NOT NULL AND
     "sessionRowId" = "sessionId" AND "sessionRowOwnerAccountId" = "sessionOwnerAccountId")
),
ADD CONSTRAINT "SessionExecutionBinding_machine_identity_check" CHECK (
    ("machineRowId" IS NULL AND "machineRowOwnerAccountId" IS NULL) OR
    ("machineRowId" IS NOT NULL AND "machineRowOwnerAccountId" IS NOT NULL AND
     "machineRowId" = "machineId" AND "machineRowOwnerAccountId" = "machineOwnerAccountId")
);
