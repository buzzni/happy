import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { confirmScopeProfile, replaceSessionWriteScope, scopeSandboxEnvironment } from './sessionWriteScopeRestart';
import { SandboxConfigSchema } from '@/persistence';

describe('scope provider replacement', () => {
  it('ends receipt waiting on replacement exit and detaches the listener', async () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
    const waiting = confirmScopeProfile(child as any, new Promise(() => {}));
    const rejected = expect(waiting).rejects.toThrow('SCOPE_PROFILE_CHILD_EXITED');
    child.emit('exit', 1); await rejected; expect(child.listenerCount('exit')).toBe(0);
    expect(await confirmScopeProfile(child as any, Promise.resolve(true))).toBe(true);
    expect(child.listenerCount('exit')).toBe(0);
  });
  it('does not widen a busy session or treat live-child resume as application', async () => {
    const resume = vi.fn();
    await expect(replaceSessionWriteScope({ busy: true, child: null, preserve: () => true, resume,
      waitForProfile: async () => true, environment: {} })).rejects.toThrow('SESSION_SCOPE_BUSY');
    expect(resume).not.toHaveBeenCalled();
  });
  it('waits for actual child exit and new profile acknowledgement; root exit is not cleanup proof', async () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null,
      kill: vi.fn(() => { queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0); }); return true; }) });
    const resume = vi.fn(async () => { expect(child.exitCode).toBe(0); return { type: 'success' }; });
    const result = await replaceSessionWriteScope({ busy: false, child: child as any,
      preserve: () => true, resume, waitForProfile: async () => true, environment: {} });
    expect(result).toEqual({ profileApplied: true, cleanup: 'unresolved' });
  });
  it('does not accept successful resume without profile confirmation', async () => {
    const result = await replaceSessionWriteScope({ busy: false, child: null, preserve: () => true,
      resume: async () => ({ type: 'success' }), waitForProfile: async () => false, environment: {} });
    expect(result).toEqual({ profileApplied: false, cleanup: 'unresolved', error: 'SCOPE_PROFILE_UNCONFIRMED' });
  });
  it('preserves unresolved cleanup when stopping an owned process cannot be confirmed', async () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: () => false });
    const resume = vi.fn();
    expect(await replaceSessionWriteScope({ busy: false, child: child as any, preserve: () => true,
      resume, waitForProfile: async () => true, environment: {} })).toEqual({ profileApplied: false, cleanup: 'unresolved', error: 'ROOT_STOP_FAILED' });
    expect(resume).not.toHaveBeenCalled();
  });
  it('keeps resume failure distinct from missing profile evidence without exposing raw errors', async () => {
    for (const resume of [async () => ({ type: 'error' }), async () => { throw new Error('TOKEN=private'); }]) {
      const confirm = vi.fn();
      expect(await replaceSessionWriteScope({ busy: false, child: null, preserve: () => true,
        resume, waitForProfile: confirm, environment: {} })).toEqual({
          profileApplied: false, cleanup: 'unresolved', error: 'SCOPE_RESUME_FAILED',
        });
      expect(confirm).not.toHaveBeenCalled();
    }
  });
  it('preserves original denies and baseline; requires isolation and rejects conflicting deny', () => {
    const config = SandboxConfigSchema.parse({ denyWritePaths: ['/policy'] });
    const root = { requestedPath: '/home/me/.local/tools', root: '/home/me/.local/tools', identity: '1:2', floor: ['/keys'] };
    const result = scopeSandboxEnvironment(config, [root], '/project');
    const applied = JSON.parse(result.HAPPY_PROJECT_SANDBOX_CONFIG);
    expect(applied.denyWritePaths).toEqual(['/policy', '/keys']);
    expect(applied.extraWritePaths).toContain(root.root);
    expect(result.HAPPY_WRITE_SCOPE_BASE_CONFIG).toBe(JSON.stringify(config));
    expect(() => scopeSandboxEnvironment({ ...config, enabled: false }, [root], '/project')).toThrow();
    expect(() => scopeSandboxEnvironment({ ...config, denyWritePaths: [root.root] }, [root], '/project')).toThrow();
  });
  it('does not signal or resume when authenticated preservation is unconfirmed', async () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn() });
    const resume = vi.fn();
    expect(await replaceSessionWriteScope({ busy: false, child: child as any, preserve: () => true,
      drain: async () => false, resume, waitForProfile: async () => true, environment: {} }))
      .toEqual({ profileApplied: false, cleanup: 'unresolved', error: 'SCOPE_DRAIN_UNCONFIRMED' });
    expect(child.kill).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
  });
});
