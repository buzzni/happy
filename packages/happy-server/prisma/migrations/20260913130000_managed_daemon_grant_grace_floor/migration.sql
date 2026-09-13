-- The renewal grace covers every generation issued inside its window, not
-- only the one directly before the current one. A parent that renews twice
-- before the daemon applied the first renewal (worker restart, second replica)
-- must not push the daemon two generations back and out.
ALTER TABLE "ManagedDaemonGrant" ADD COLUMN "graceFloorGeneration" INTEGER;
