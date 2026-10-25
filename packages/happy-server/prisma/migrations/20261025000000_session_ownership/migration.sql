-- CreateTable
CREATE TABLE "SessionOwnershipBinding" (
    "sessionId" TEXT NOT NULL,
    "sessionRowId" TEXT,
    "bindingId" TEXT NOT NULL,
    "subjectIssuer" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "sessionAccountId" TEXT NOT NULL,
    "originProjectId" TEXT,
    "machineId" TEXT NOT NULL,
    "machineAccountId" TEXT NOT NULL,
    "companyId" TEXT,
    "parentHubSessionId" TEXT,
    "intentId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "createDigest" TEXT NOT NULL,
    "proofDigest" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "SessionOwnershipBinding_pkey" PRIMARY KEY ("sessionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionOwnershipBinding_sessionRowId_key" ON "SessionOwnershipBinding"("sessionRowId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionOwnershipBinding_bindingId_key" ON "SessionOwnershipBinding"("bindingId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionOwnershipBinding_subjectIssuer_intentId_key" ON "SessionOwnershipBinding"("subjectIssuer", "intentId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionOwnershipBinding_subjectIssuer_operationId_key" ON "SessionOwnershipBinding"("subjectIssuer", "operationId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionOwnershipBinding_subjectIssuer_nonce_key" ON "SessionOwnershipBinding"("subjectIssuer", "nonce");

-- AddForeignKey
ALTER TABLE "SessionOwnershipBinding" ADD CONSTRAINT "SessionOwnershipBinding_sessionRowId_fkey" FOREIGN KEY ("sessionRowId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

ALTER TABLE "SessionOwnershipBinding" ADD CONSTRAINT "SessionOwnershipBinding_live_identity"
CHECK ("sessionRowId" IS NULL OR "sessionRowId" = "sessionId");

-- Keep nonce/operation tombstones on deletion; confirmation is a one-way transition.
CREATE FUNCTION session_ownership_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'confirmedAt' - 'sessionRowId') IS DISTINCT FROM
     (to_jsonb(OLD) - 'confirmedAt' - 'sessionRowId') OR
     (OLD."confirmedAt" IS NOT NULL AND NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt") OR
     (NEW."sessionRowId" IS NOT NULL AND NEW."sessionRowId" IS DISTINCT FROM OLD."sessionRowId") THEN
    RAISE EXCEPTION 'immutable session ownership' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_ownership_immutable BEFORE UPDATE ON "SessionOwnershipBinding"
FOR EACH ROW EXECUTE FUNCTION session_ownership_immutable();
