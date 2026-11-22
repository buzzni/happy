CREATE TABLE "WorkMachineExecution" (
    "machineId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL CHECK ("generation" > 0),
    "deviceId" TEXT NOT NULL,
    "previousDeviceId" TEXT,
    "drainingAt" TIMESTAMP(3),
    "frozenAt" TIMESTAMP(3),
    "firstExecutionAt" TIMESTAMP(3),

    CONSTRAINT "WorkMachineExecution_pkey" PRIMARY KEY ("machineId")
);

CREATE UNIQUE INDEX "WorkMachineExecution_machineId_accountId_key"
    ON "WorkMachineExecution" ("machineId", "accountId");
CREATE INDEX "WorkMachineExecution_accountId_idx" ON "WorkMachineExecution" ("accountId");

ALTER TABLE "WorkMachineExecution"
    ADD CONSTRAINT "WorkMachineExecution_machineId_accountId_fkey"
    FOREIGN KEY ("machineId", "accountId") REFERENCES "Machine"("id", "accountId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "WorkMachineMcpCall" (
    "requestId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL CHECK ("generation" > 0),
    "admittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "reconciledAt" TIMESTAMP(3),
    CONSTRAINT "WorkMachineMcpCall_pkey" PRIMARY KEY ("requestId"),
    CONSTRAINT "WorkMachineMcpCall_machineId_accountId_fkey"
        FOREIGN KEY ("machineId", "accountId") REFERENCES "WorkMachineExecution"("machineId", "accountId")
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "WorkMachineMcpCall_machineId_completedAt_idx"
    ON "WorkMachineMcpCall" ("machineId", "completedAt");

CREATE TABLE "WorkMachineRenewalProof" (
    "machineId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkMachineRenewalProof_pkey" PRIMARY KEY ("machineId", "nonce"),
    CONSTRAINT "WorkMachineRenewalProof_machineId_fkey"
        FOREIGN KEY ("machineId") REFERENCES "WorkMachineExecution"("machineId")
        ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WorkMachineRenewalProof_machineId_expiresAt_idx"
    ON "WorkMachineRenewalProof" ("machineId", "expiresAt");

ALTER TABLE "Session" ADD COLUMN "workMachineId" TEXT;
CREATE INDEX "Session_workMachineId_accountId_idx" ON "Session" ("workMachineId", "accountId");
CREATE INDEX "SessionOwnershipBinding_machineId_machineAccountId_idx"
    ON "SessionOwnershipBinding" ("machineId", "machineAccountId");
-- Added NOT VALID so the ALTER does not scan "Session" under its lock; the
-- separate VALIDATE checks existing rows without blocking writes.
ALTER TABLE "Session"
    ADD CONSTRAINT "Session_workMachineId_accountId_fkey"
    FOREIGN KEY ("workMachineId", "accountId") REFERENCES "WorkMachineExecution"("machineId", "accountId")
    ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "Session" VALIDATE CONSTRAINT "Session_workMachineId_accountId_fkey";
