import { logger } from '@/ui/logger';
import type { SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import type { WorkspaceTurnAdmissionResult } from '@/utils/workspaceTurnAdmission';

/** A refused manual launch, logged with its reason; only an automatic owner is reported as a scheduled task. */
export function manualLaunchRefusal(refusal: Exclude<WorkspaceTurnAdmissionResult, { acquired: true }>): SpawnSessionResult {
  const message = `[workspace-admission] Manual launch refused: ${refusal.reason} (${refusal.sessions.join(', ') || 'no owner session'})`;
  if (refusal.reason === 'workspace-busy') logger.debug(message);
  else logger.warn(message);
  if (refusal.reason === 'registry-busy') return { type: 'error', code: 'workspace-registry-busy',
    errorMessage: 'This PC could not record the workspace launch. Retry shortly.' };
  if (refusal.reason === 'workspace-owner-unconfirmed') return { type: 'error', code: 'workspace-owner-unconfirmed',
    errorMessage: 'Workspace ownership from a previous task is unconfirmed. Retry after its execution state is recovered.' };
  return { type: 'error', code: 'workspace-automation-busy',
    errorMessage: 'This workspace is running a scheduled task. Retry after it finishes.' };
}
