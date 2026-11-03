import { expect, it, vi } from 'vitest';
vi.mock('@/codex/codexMultiAuthProxy', () => ({ prepareCodexMultiAuthProxy: vi.fn(async () => null) }));
import { resolveReservationNativeAuth } from './reservationNativeAuth';
it('resolves the explicitly selected Claude token without reading another account or copying credential files', async () => {
  const read = vi.fn();
  const auth = await resolveReservationNativeAuth({ agent: 'claude', home: '/selected', environment: { CLAUDE_CODE_OAUTH_TOKEN: 'selected-secret' } }, read);
  expect(auth.headers.Authorization).toBe('Bearer selected-secret'); expect(read).not.toHaveBeenCalled();
});
it('reads only the selected Codex home and refuses a missing account instead of falling back to the daemon account', async () => {
  const read = vi.fn(async file => { expect(file).toBe('/selected/codex/auth.json'); return JSON.stringify({ tokens: { access_token: 'selected-secret', account_id: 'selected-account' } }); });
  const auth = await resolveReservationNativeAuth({ agent: 'codex', home: '/different-home', environment: { CODEX_HOME: '/selected/codex' } }, read);
  expect(auth.headers).toMatchObject({ Authorization: 'Bearer selected-secret', 'ChatGPT-Account-Id': 'selected-account' });
  await expect(resolveReservationNativeAuth({ agent: 'codex', home: '/selected', environment: {} }, async () => '{}')).rejects.toThrow('RESERVATION_SELECTED_AI_AUTH_UNAVAILABLE');
});

it('keeps selected GitHub credentials in the host and does not fall back from a missing selected credential', async () => {
  const { resolveReservationNativeGithub } = await import('./reservationNativeAuth'); const run = vi.fn();
  expect(await resolveReservationNativeGithub({ directory: '/project', environment: { GH_TOKEN: 'selected-only', GH_REPO: 'owner/repo' }, allowMachineDefault: false }, run as never))
    .toEqual({ token: 'selected-only', repository: 'owner/repo' });
  await expect(resolveReservationNativeGithub({ directory: '/project', environment: {}, allowMachineDefault: false }, run as never)).rejects.toThrow('RESERVATION_SELECTED_GITHUB_AUTH_UNAVAILABLE');
  expect(run).not.toHaveBeenCalled();
});
it('resolves the existing machine gh default only in the trusted host with fixed argument arrays', async () => {
  const { resolveReservationNativeGithub } = await import('./reservationNativeAuth');
  const run = vi.fn().mockResolvedValueOnce({ stdout: JSON.stringify({ nameWithOwner: 'owner/repo', url: 'https://github.com/owner/repo' }) }).mockResolvedValueOnce({ stdout: 'machine-only-token\n' });
  expect(await resolveReservationNativeGithub({ directory: '/project', environment: {}, allowMachineDefault: true }, run as never)).toEqual({ token: 'machine-only-token', repository: 'owner/repo' });
  expect(run).toHaveBeenLastCalledWith('gh', ['auth', 'token', '--hostname', 'github.com'], expect.objectContaining({ cwd: '/project', timeout: 10000 }));
});
