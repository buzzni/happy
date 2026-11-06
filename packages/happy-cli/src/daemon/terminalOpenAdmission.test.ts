import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { bindRpcRequest } from '@slopus/happy-wire';
import { validatePath } from '@/modules/common/pathSecurity';
import { createLegacyDispatchAdmission, createSubprocessWriteAdmission, createWorkspaceTurnAdmission } from '@/utils/workspaceTurnAdmission';
import { createTerminalOpenNonceGuard } from './terminalBindingSession';
import { prepareTerminalOpen, type TerminalOpenAdmissionInput } from './terminalOpenAdmission';

const machineId = 'terminal-admission-machine';
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fixture() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'terminal-admission-'))); homes.push(home);
    const project = join(home, 'project'), other = join(home, 'other');
    mkdirSync(project); mkdirSync(other);
    const nonceGuard = createTerminalOpenNonceGuard();
    const request = (cwd = project, nonce = randomBytes(16).toString('base64')) => bindRpcRequest({
        method: 'terminal-open', scope: machineId, issuedAt: Date.now(), nonce,
        params: { terminalBinding: 1, terminalKey: randomBytes(32).toString('base64'),
            terminalId: randomBytes(16).toString('base64'), cwd, cols: 80, rows: 24 },
    });
    const input = (opened = request()): TerminalOpenAdmissionInput => ({ opened, machineId, strict: true, nonceGuard,
        cwd: { allowedRoot: home, homedir: home, fsExists: existsSync, fsMkdir: path => { mkdirSync(path, { recursive: true }); }, validate: validatePath },
        reserveLegacyDispatch: createLegacyDispatchAdmission({ home }), admitSubprocess: createSubprocessWriteAdmission({ home }),
    });
    const automatic = (root = project) => createWorkspaceTurnAdmission({ home, roots: [root], kind: 'automation', sessionId: `automation-run:${randomBytes(12).toString('hex')}` });
    return { home, project, other, request, input, automatic };
}

async function ready(input: TerminalOpenAdmissionInput) {
    const result = await prepareTerminalOpen(input);
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error(result.code);
    return result;
}

describe('prepareTerminalOpen', () => {
    it('holds a terminal before nonce consumption and permits the same request after proven automatic release', async () => {
        const f = fixture(), owner = f.automatic(), input = f.input();
        expect(await owner.tryAcquire()).toEqual({ acquired: true });
        expect(await prepareTerminalOpen(input)).toMatchObject({ kind: 'refused', code: 'WORKSPACE_UNAVAILABLE' });
        expect(await owner.release(true)).toBe(true);
        const prepared = await ready(input);
        expect(prepared.cwdDecision.cwd).toBe(f.project);
        await prepared.submit(() => undefined);
        expect(await f.automatic().tryAcquire()).toMatchObject({ acquired: false, reason: 'workspace-owner-unconfirmed' });
    });

    it('does not reserve the whole home when a different project has an automatic owner', async () => {
        const f = fixture(), owner = f.automatic(f.other);
        expect(await owner.tryAcquire()).toEqual({ acquired: true });
        try {
            const prepared = await ready(f.input());
            expect(prepared.cwdDecision.cwd).toBe(f.project);
            await prepared.cancel();
        }
        finally { await owner.release(true); }
    });

    it('creates a validated missing cwd under reservation before retaining its actual inode', async () => {
        const f = fixture(), directory = join(f.home, 'new', 'project');
        const prepared = await ready(f.input(f.request(directory)));
        expect(prepared.cwdDecision.cwd).toBe(directory);
        expect(existsSync(directory)).toBe(true);
        await prepared.submit(() => undefined);
        expect(await f.automatic(directory).tryAcquire()).toMatchObject({ acquired: false, reason: 'workspace-owner-unconfirmed' });
    });

    it('refuses an unsafe fallback before PTY submission when the fallback overlaps automatic work', async () => {
        const f = fixture(), owner = f.automatic(f.other);
        expect(await owner.tryAcquire()).toEqual({ acquired: true });
        const input = f.input(f.request(join(f.home, 'missing')));
        input.cwd.fsMkdir = () => { throw new Error('mkdir failed'); };
        try { expect(await prepareTerminalOpen(input)).toMatchObject({ kind: 'refused', code: 'WORKSPACE_UNAVAILABLE' }); }
        finally { await owner.release(true); }
    });

    it('does not retain a replay with a different cwd as a new writer', async () => {
        const f = fixture(), request = f.request();
        await (await ready(f.input(request))).submit(() => undefined);
        expect(await prepareTerminalOpen(f.input(f.request(f.other, request.nonce))))
            .toMatchObject({ kind: 'refused', code: 'RPC_REQUEST_REPLAYED' });
        const owner = f.automatic(f.other);
        expect(await owner.tryAcquire()).toEqual({ acquired: true });
        await owner.release(true);
    });

    it('validates binding before any workspace or mkdir effect', async () => {
        const f = fixture(), request = f.request(), input = f.input({ ...request, scope: 'another-machine' });
        const reserve = vi.fn(input.reserveLegacyDispatch!); input.reserveLegacyDispatch = reserve;
        const mkdir = vi.fn(input.cwd.fsMkdir); input.cwd.fsMkdir = mkdir;
        expect(await prepareTerminalOpen(input)).toMatchObject({ kind: 'refused', code: 'RPC_SCOPE_MISMATCH' });
        expect(reserve).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
    });

    it('rechecks binding expiration after reservation before mkdir or durable writer handoff', async () => {
        const f = fixture(), request = f.request(), input = f.input(request);
        let now = request.issuedAt;
        const finish = vi.fn(async () => undefined), admit = vi.fn(async () => undefined), mkdir = vi.fn(input.cwd.fsMkdir);
        input.now = () => now;
        input.reserveLegacyDispatch = async () => { now += 6 * 60_000; return { acquired: true, finish }; };
        input.admitSubprocess = admit; input.cwd.fsMkdir = mkdir;
        expect(await prepareTerminalOpen(input)).toMatchObject({ kind: 'refused', code: 'RPC_REQUEST_STALE' });
        expect(admit).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled(); expect(finish).toHaveBeenCalledOnce();
    });

    it('holds a partially configured host without consuming the opening', async () => {
        const f = fixture(), input = f.input(); input.reserveLegacyDispatch = undefined;
        expect(await prepareTerminalOpen(input)).toMatchObject({ kind: 'refused', code: 'WORKSPACE_ADMISSION_UNAVAILABLE' });
        input.reserveLegacyDispatch = createLegacyDispatchAdmission({ home: f.home });
        await (await ready(input)).cancel();
    });

    it('releases a cancelled preparation without retaining an unfenced writer', async () => {
        const f = fixture(), prepared = await ready(f.input());
        await prepared.cancel();
        const owner = f.automatic();
        expect(await owner.tryAcquire()).toEqual({ acquired: true });
        await owner.release(true);
        const start = vi.fn();
        await expect(prepared.submit(start)).rejects.toThrow('TERMINAL_OPEN_ALREADY_SETTLED');
        expect(start).not.toHaveBeenCalled();
    });

    it('keeps the temporary owner through synchronous submission and durable retention', async () => {
        const f = fixture(), input = f.input();
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const retain = input.admitSubprocess!;
        input.admitSubprocess = async roots => { await gate; await retain(roots); };
        const prepared = await ready(input), start = vi.fn();
        const submitted = prepared.submit(start);
        expect(start).toHaveBeenCalledOnce();
        try {
            expect(await f.automatic().tryAcquire()).toMatchObject({ acquired: false });
            await prepared.cancel();
            expect(await f.automatic().tryAcquire()).toMatchObject({ acquired: false });
        } finally { release(); await submitted; }
        expect(await f.automatic().tryAcquire()).toMatchObject({ acquired: false, reason: 'workspace-owner-unconfirmed' });
        await expect(prepared.submit(start)).rejects.toThrow('TERMINAL_OPEN_ALREADY_SETTLED');
        expect(start).toHaveBeenCalledOnce();
    });

    it.each([false, true])('retains submitted ownership without replacing the original throw=%s result when tracking fails', async throws => {
        const f = fixture(), input = f.input();
        input.admitSubprocess = async () => { throw new Error('WORKSPACE_REGISTRY_BUSY'); };
        const prepared = await ready(input), start = vi.fn(() => { if (throws) throw new Error('original spawn failure'); });
        if (throws) await expect(prepared.submit(start)).rejects.toThrow('original spawn failure');
        else await expect(prepared.submit(start)).resolves.toBeUndefined();
        expect(start).toHaveBeenCalledOnce();
        await prepared.cancel();
        expect(await f.automatic().tryAcquire()).toMatchObject({ acquired: false });
    });
});
