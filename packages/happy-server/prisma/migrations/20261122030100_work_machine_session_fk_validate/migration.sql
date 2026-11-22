-- Separate from the migration that added the constraint NOT VALID, so the
-- write-blocking lock taken there is released before existing rows are scanned.
ALTER TABLE "Session" VALIDATE CONSTRAINT "Session_workMachineId_accountId_fkey";
