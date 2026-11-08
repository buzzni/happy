-- Keep the history links after source retention/deletion; missing data must fail closed.
ALTER TABLE "Automation" ADD COLUMN "lastExecutionRunId" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "previousExecutionRunId" TEXT;

-- Earlier private registrations have no explicit registration sequence. Preserve their
-- deterministic creation order; legacy/manual runs are never reference candidates.
WITH history AS (
  SELECT "id", LAG("id") OVER (PARTITION BY "automationId" ORDER BY "createdAt", "id") AS previous
  FROM "AutomationRun"
  WHERE "executionCreateBodyHash" IS NOT NULL OR "displaySessionId" IS NOT NULL
    OR "sessionId" LIKE 'automation-run:%'
)
UPDATE "AutomationRun" AS run SET "previousExecutionRunId" = history.previous
FROM history WHERE run."id" = history."id";

WITH heads AS (
  SELECT DISTINCT ON ("automationId") "automationId", "id"
  FROM "AutomationRun"
  WHERE "executionCreateBodyHash" IS NOT NULL OR "displaySessionId" IS NOT NULL
    OR "sessionId" LIKE 'automation-run:%'
  ORDER BY "automationId", "createdAt" DESC, "id" DESC
)
UPDATE "Automation" AS definition SET "lastExecutionRunId" = heads."id"
FROM heads WHERE definition."id" = heads."automationId";
