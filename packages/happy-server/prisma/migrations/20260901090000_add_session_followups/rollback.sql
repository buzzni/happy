ALTER TABLE "SessionFollowupHistory" DROP CONSTRAINT "SessionFollowupHistory_followupId_fkey";
ALTER TABLE "SessionFollowup" DROP CONSTRAINT "SessionFollowup_ownerAccountId_fkey";
ALTER TABLE "SessionFollowup" DROP CONSTRAINT "SessionFollowup_projectId_fkey";

DROP TABLE "SessionFollowupHistory";
DROP TABLE "SessionFollowupChange";
DROP TABLE "SessionFollowup";

DROP TYPE "SessionFollowupHistoryKind";
DROP TYPE "SessionFollowupChangeKind";
DROP TYPE "SessionFollowupTerminalCode";
DROP TYPE "SessionFollowupStatus";
