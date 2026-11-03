-- Older deployments already have this value and historical rows using it.
-- Fresh deployments also need it to accept pending reports from older daemons.
ALTER TYPE "AutomationRunOutcome" ADD VALUE IF NOT EXISTS 'NO_CHANGE';
