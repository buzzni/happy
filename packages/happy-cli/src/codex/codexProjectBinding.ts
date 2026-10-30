import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

type ProjectRequest = (
    method: 'project/list' | 'thread/metadata/update',
    params: Record<string, unknown>,
    timeoutMs: number,
) => Promise<unknown>;

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Optional native display metadata must never delay or fail Happy's thread creation. */
export async function bindCodexThreadToProject(input: {
    threadId: string;
    cwd: string;
    projectRoot: string | undefined;
    request: ProjectRequest;
}): Promise<void> {
    try {
        if (!input.projectRoot || !isAbsolute(input.projectRoot) || !isAbsolute(input.cwd)) return;
        const [root, cwd] = await Promise.all([realpath(input.projectRoot), realpath(input.cwd)]);
        const child = relative(root, cwd);
        if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) return;

        const deadline = Date.now() + 1500;
        const request: ProjectRequest = (method, params, maxTimeout) => {
            const remaining = Math.min(maxTimeout, deadline - Date.now());
            if (remaining <= 0) return Promise.reject(new Error('Codex project binding deadline exceeded'));
            return input.request(method, params, remaining);
        };
        const matches = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | null = null;
        for (let page = 0; page < 8; page++) {
            const result = await request('project/list', { cursor, limit: 100 }, 1500);
            if (!record(result) || !Array.isArray(result.data) || result.data.length > 100) return;
            for (const project of result.data) {
                if (!record(project) || typeof project.id !== 'string' || !project.id || !Array.isArray(project.roots)) return;
                for (const directory of project.roots) {
                    if (!record(directory) || typeof directory.path !== 'string' || !isAbsolute(directory.path)) return;
                    const registeredRoot = await realpath(directory.path).catch(() => null);
                    if (registeredRoot === root) matches.add(project.id);
                }
            }
            if (result.nextCursor == null) {
                if (matches.size === 1) {
                    for (let attempt = 0; attempt < 4; attempt++) {
                        try {
                            await request('thread/metadata/update', { threadId: input.threadId, projectId: [...matches][0] }, 1500);
                            return;
                        } catch (error) {
                            // Codex acknowledges turn/start before its first rollout is fully flushed.
                            if (!(error instanceof Error) || !/no rollout found for thread id|rollout at .+ is empty/.test(error.message) || attempt === 3) return;
                            await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
                        }
                    }
                }
                return;
            }
            if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor)) return;
            cursor = result.nextCursor;
            cursors.add(cursor);
        }
    } catch {
        // COMPAT(codex-project-binding): added 2026-10-28; retain until every supported
        // Codex implements project/list and thread/metadata/update. This display-only
        // enrichment also tolerates deleted projects, shutdown and replaced connections.
    }
}
