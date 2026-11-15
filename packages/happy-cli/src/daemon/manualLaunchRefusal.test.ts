import { describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { manualLaunchRefusal } from './manualLaunchRefusal';

describe('manualLaunchRefusal', () => {
  it('reports a scheduled task only when an automatic owner holds the workspace', () => {
    expect(manualLaunchRefusal({ acquired: false, reason: 'workspace-busy', sessions: ['automation-run:r1'] })).toEqual({
      type: 'error', code: 'workspace-automation-busy', errorMessage: 'This workspace is running a scheduled task. Retry after it finishes.',
    });
  });

  it('does not blame a scheduled task when the ownership registry itself refused the launch', () => {
    const result = manualLaunchRefusal({ acquired: false, reason: 'registry-busy', sessions: [] });
    expect(result).toMatchObject({ type: 'error', code: 'workspace-registry-busy' });
    expect(result.type === 'error' && result.errorMessage).not.toMatch(/scheduled task/);
  });

  it('reports unconfirmed workspace ownership separately from a running scheduled task', () => {
    expect(manualLaunchRefusal({ acquired: false, reason: 'workspace-owner-unconfirmed', sessions: ['manual-launch:old'] })).toEqual({
      type: 'error', code: 'workspace-owner-unconfirmed',
      errorMessage: 'Workspace ownership from a previous task is unconfirmed. Retry after its execution state is recovered.',
    });
  });

  it('logs the refusal reason and the sessions that hold the workspace', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      manualLaunchRefusal({ acquired: false, reason: 'workspace-owner-unconfirmed', sessions: ['automation-run:r2'] });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/workspace-owner-unconfirmed.*automation-run:r2/));
    } finally { warn.mockRestore(); }
  });
});
