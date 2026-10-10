import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const fixture = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: fixture.run }));
vi.mock('node:fs', () => ({ lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: 7 }), readFileSync: () => Buffer.from('fixture') }));
vi.mock('node:os', () => ({ platform: () => 'win32' }));
import { createWindowsUserProtection } from './windowsUserProtection';
const api = createWindowsUserProtection({ helperPath: 'C:\\Saycode\\user-protection.exe', helperSha256: createHash('sha256').update('fixture').digest('hex') });
const file = 'C:\\Users\\Fixture\\machine\\access.key';
beforeEach(() => { fixture.run.mockReset(); fixture.run.mockReturnValue({ status: 0, stdout: JSON.stringify({ version: 1, ok: true, value: Buffer.from('ok').toString('base64') }) }); });
it('sends file publication and final-file binding in the private protocol', () => {
    api.publishProtectedFile(file, '{"storage":"saycode-dpapi-v1","value":"fixture"}', 'bound-final-path', true);
    const [, args, options] = fixture.run.mock.calls[0];
    const request = JSON.parse(options.input.toString());
    expect(args).toEqual([]);
    expect(request.operation).toBe('publish-protected');
    expect(request.purpose).toBe('bound-final-path');
    expect(JSON.parse(Buffer.from(request.value, 'base64').toString())).toEqual({ path: file, contents: '{"storage":"saycode-dpapi-v1","value":"fixture"}', createOnly: true });
});
it('requests handle-verified reads, not a Node read followed by a path ACL check', () => {
    expect(api.readProtectedFile(file, 'bound-final-path').toString()).toBe('ok');
    const request = JSON.parse(fixture.run.mock.calls[0][2].input.toString());
    expect(request.operation).toBe('read-protected');
    expect(Buffer.from(request.value, 'base64').toString()).toBe(file);
});
it.each(['ENOENT', 'EEXIST'])('preserves only an allowlisted file-state error: %s', code => {
    fixture.run.mockReturnValue({ status: 1, stdout: JSON.stringify({ version: 1, ok: false, error: code }) });
    expect(() => api.readProtectedFile(file, 'purpose')).toThrow(expect.objectContaining({ code }));
});
