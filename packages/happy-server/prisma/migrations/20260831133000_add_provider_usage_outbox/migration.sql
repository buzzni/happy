CREATE TABLE "ProviderUsageEvent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderUsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsageDeliveryOutbox" (
    "id" TEXT NOT NULL,
    "usageEventId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageDeliveryOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderUsageEvent_source_sourceEventId_key"
ON "ProviderUsageEvent"("source", "sourceEventId");
CREATE INDEX "ProviderUsageEvent_accountId_occurredAt_idx"
ON "ProviderUsageEvent"("accountId", "occurredAt");
CREATE INDEX "ProviderUsageEvent_sessionId_occurredAt_idx"
ON "ProviderUsageEvent"("sessionId", "occurredAt");
CREATE UNIQUE INDEX "UsageDeliveryOutbox_usageEventId_key"
ON "UsageDeliveryOutbox"("usageEventId");
CREATE INDEX "UsageDeliveryOutbox_status_nextAttemptAt_idx"
ON "UsageDeliveryOutbox"("status", "nextAttemptAt");
CREATE INDEX "UsageDeliveryOutbox_status_leaseUntil_idx"
ON "UsageDeliveryOutbox"("status", "leaseUntil");

ALTER TABLE "ProviderUsageEvent"
ADD CONSTRAINT "ProviderUsageEvent_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UsageDeliveryOutbox"
ADD CONSTRAINT "UsageDeliveryOutbox_usageEventId_fkey"
FOREIGN KEY ("usageEventId") REFERENCES "ProviderUsageEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
