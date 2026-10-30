import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindCodexThreadToProject } from './codexProjectBinding';

describe('Codex native project binding', () => {
    let fixture: string;
    let projectRoot: string;
    let cwd: string;

    beforeEach(async () => {
        fixture = await mkdtemp(join(tmpdir(), 'codex-project-binding-'));
        projectRoot = join(fixture, 'repo');
        cwd = join(projectRoot, '.aplus', 'worktrees', 'panda');
        await mkdir(cwd, { recursive: true });
    });

    afterEach(async () => { await rm(fixture, { recursive: true, force: true }); });

    function project(id = 'native-project', path = projectRoot) {
        return { id, roots: [{ path }] };
    }

    function bind(request: ReturnType<typeof vi.fn>, root: string | undefined = projectRoot, directory = cwd) {
        return bindCodexThreadToProject({ threadId: 'thread-new', cwd: directory, projectRoot: root, request });
    }

    it('assigns only the existing exact project, without changing the working directory', async () => {
        const request = vi.fn().mockResolvedValueOnce({ data: [project()], nextCursor: null }).mockResolvedValueOnce({});
        await bind(request);
        expect(request.mock.calls.map(call => call.slice(0, 2))).toEqual([
            ['project/list', { cursor: null, limit: 100 }],
            ['thread/metadata/update', { threadId: 'thread-new', projectId: 'native-project' }],
        ]);
        expect(request.mock.calls.every(call => call[2] > 0 && call[2] <= 1500)).toBe(true);
    });

    it('compares canonical paths so a registered symlink still matches', async () => {
        const alias = join(fixture, 'alias');
        await symlink(projectRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
        const request = vi.fn().mockResolvedValueOnce({ data: [project('native-project', alias)], nextCursor: null }).mockResolvedValueOnce({});
        await bind(request);
        expect(request).toHaveBeenLastCalledWith('thread/metadata/update', { threadId: 'thread-new', projectId: 'native-project' }, expect.any(Number));
    });

    it('checks every page before choosing the unique exact root', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce({ data: [project('other', fixture)], nextCursor: 'page2' })
            .mockResolvedValueOnce({ data: [project()], nextCursor: null })
            .mockResolvedValueOnce({});
        await bind(request);
        expect(request).toHaveBeenNthCalledWith(2, 'project/list', { cursor: 'page2', limit: 100 }, expect.any(Number));
        expect(request).toHaveBeenLastCalledWith('thread/metadata/update', { threadId: 'thread-new', projectId: 'native-project' }, expect.any(Number));
    });

    it('does not choose between projects with the same exact root across pages', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce({ data: [project('first')], nextCursor: 'page2' })
            .mockResolvedValueOnce({ data: [project('second')], nextCursor: null });
        await bind(request);
        expect(request).toHaveBeenCalledTimes(2);
        expect(request.mock.calls.every(call => call[0] === 'project/list')).toBe(true);
    });

    it('does not create or guess a project from an ancestor or a folder name', async () => {
        const request = vi.fn().mockResolvedValue({ data: [project('parent', fixture)], nextCursor: null });
        await bind(request);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it.each([undefined, '', 'relative/root'])('skips an absent or invalid original scope: %s', async root => {
        const request = vi.fn();
        await bindCodexThreadToProject({ threadId: 'thread-new', cwd, projectRoot: root, request });
        expect(request).not.toHaveBeenCalled();
    });

    it('does not bind a session outside its canonical project scope', async () => {
        const outside = join(fixture, 'repo-other');
        await mkdir(outside);
        const request = vi.fn();
        await bind(request, projectRoot, outside);
        expect(request).not.toHaveBeenCalled();
    });

    it('does not trust a symlink escaping the project scope', async () => {
        const outside = join(fixture, 'outside');
        await mkdir(outside);
        const link = join(projectRoot, 'escape');
        await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
        const request = vi.fn();
        await bind(request, projectRoot, link);
        expect(request).not.toHaveBeenCalled();
    });

    it.each([
        new Error('project/list: method not found (code=-32601)'),
        new Error('project/list timed out'),
        new Error('Codex connection replaced'),
    ])('contains optional project lookup failures: %s', async failure => {
        const request = vi.fn().mockRejectedValue(failure);
        await expect(bind(request)).resolves.toBeUndefined();
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('contains assignment failure without retrying or starting another thread', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce({ data: [project()], nextCursor: null })
            .mockRejectedValueOnce(new Error('project deleted'));
        await expect(bind(request)).resolves.toBeUndefined();
        expect(request).toHaveBeenCalledTimes(2);
    });

    it.each(['no rollout found for thread id thread-new', 'rollout at /fixture/rollout.jsonl is empty'])('retries only the first-turn rollout flush race: %s', async message => {
        const request = vi.fn()
            .mockResolvedValueOnce({ data: [project()], nextCursor: null })
            .mockRejectedValueOnce(new Error(message))
            .mockResolvedValueOnce({});
        await bind(request);
        expect(request).toHaveBeenCalledTimes(3);
        expect(request.mock.calls[1].slice(0, 2)).toEqual(request.mock.calls[2].slice(0, 2));
    });

    it('bounds retries if the first rollout never becomes readable', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce({ data: [project()], nextCursor: null })
            .mockRejectedValue(new Error('no rollout found for thread id thread-new'));
        await expect(bind(request)).resolves.toBeUndefined();
        expect(request).toHaveBeenCalledTimes(5);
    });

    it.each([{}, { data: null }, { data: [{ id: 'broken' }], nextCursor: null }, { data: [], nextCursor: 1 }])('skips malformed project pages: %j', async response => {
        const request = vi.fn().mockResolvedValue(response);
        await bind(request);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('does not assign from an incomplete lookup when a later page fails', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce({ data: [project()], nextCursor: 'page2' })
            .mockRejectedValueOnce(new Error('project/list unavailable'));
        await expect(bind(request)).resolves.toBeUndefined();
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('bounds pagination and does not accept an incomplete project list', async () => {
        const request = vi.fn().mockImplementation(async () => ({ data: [project()], nextCursor: `page${request.mock.calls.length}` }));
        await bind(request);
        expect(request.mock.calls.length).toBeLessThanOrEqual(8);
        expect(request.mock.calls.every(call => call[0] === 'project/list')).toBe(true);
    });
});
