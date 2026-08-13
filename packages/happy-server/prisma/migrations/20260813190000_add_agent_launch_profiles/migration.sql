CREATE TABLE "AgentLaunchProfile" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "model" TEXT,
    "worktreeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentLaunchProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentLaunchProfile_accountId_name_key"
    ON "AgentLaunchProfile"("accountId", "name");
CREATE INDEX "AgentLaunchProfile_accountId_active_idx"
    ON "AgentLaunchProfile"("accountId", "active");
CREATE UNIQUE INDEX "AgentLaunchProfile_one_active_per_account_idx"
    ON "AgentLaunchProfile"("accountId") WHERE "active" = true;

ALTER TABLE "AgentLaunchProfile"
    ADD CONSTRAINT "AgentLaunchProfile_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
