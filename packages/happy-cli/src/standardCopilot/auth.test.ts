import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createStandardCopilotTokenProvider, writePrivateAuthUrlHandoff } from './auth';

const tenantId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';

describe('Standard Copilot token provider', () => {
  it('keeps an existing browser handoff file private', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'workiq-auth-'));
    const handoffPath = path.join(directory, 'auth-url');
    await writeFile(handoffPath, 'old', { mode: 0o644 });

    await writePrivateAuthUrlHandoff(handoffPath, 'https://login.example.test/authorize');

    expect(await readFile(handoffPath, 'utf8')).toBe('https://login.example.test/authorize');
    expect((await stat(handoffPath)).mode & 0o777).toBe(0o600);
  });

  it('rejects invalid tenant and client IDs before starting Microsoft authentication', () => {
    const createClient = vi.fn();

    expect(() => createStandardCopilotTokenProvider({
      tenantId: 'common',
      clientId,
      openBrowser: vi.fn(),
    }, { createClient })).toThrow('WORKIQ_TENANT_ID');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('keeps the account in memory and silently refreshes later access tokens', async () => {
    const account = { homeAccountId: 'account-1' };
    const acquireTokenInteractive = vi.fn().mockResolvedValue({
      accessToken: 'ACCESS_TOKEN_1',
      tenantId,
      account,
    });
    const acquireTokenSilent = vi.fn().mockResolvedValue({
      accessToken: 'ACCESS_TOKEN_2',
      tenantId,
      account,
    });
    const createClient = vi.fn(() => ({ acquireTokenInteractive, acquireTokenSilent }));
    const openBrowser = vi.fn();
    const provider = createStandardCopilotTokenProvider({ tenantId, clientId, openBrowser }, { createClient });

    await expect(provider.getAccessToken()).resolves.toBe('ACCESS_TOKEN_1');
    await expect(provider.getAccessToken()).resolves.toBe('ACCESS_TOKEN_2');

    expect(acquireTokenInteractive).toHaveBeenCalledTimes(1);
    expect(acquireTokenInteractive).toHaveBeenCalledWith(expect.objectContaining({
      scopes: ['api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask'],
      openBrowser,
    }));
    expect(acquireTokenSilent).toHaveBeenCalledWith(expect.objectContaining({ account }));
  });

  it('does not expose authentication errors or tokens to the caller', async () => {
    const createClient = vi.fn(() => ({
      acquireTokenInteractive: vi.fn().mockRejectedValue(new Error('Bearer SECRET_TOKEN')),
      acquireTokenSilent: vi.fn(),
    }));
    const provider = createStandardCopilotTokenProvider({
      tenantId,
      clientId,
      openBrowser: vi.fn(),
    }, { createClient });

    await expect(provider.getAccessToken()).rejects.toThrow('Microsoft 사용자 로그인 실패');
    await expect(provider.getAccessToken()).rejects.not.toThrow('SECRET_TOKEN');
  });
});
