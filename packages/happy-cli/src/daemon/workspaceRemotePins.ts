/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary workspace-sync-strict-design.md D2 (a) — the
 * online repository each workspace folder was first connected to on this machine.
 *
 * The server chooses where `workspace:*` pushes and pulls. `origin` already pins a workspace that has
 * one; this record also pins a folder before it has one and the deploy repository, which is never
 * `origin`. A pin is written only from a fact of this machine or a user's confirmation, never from a
 * server answer alone. It lives in the daemon's own home (internal IO only; remote file handlers
 * cannot reach it, R11) and is written atomically, 0600.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '@/ui/logger';

export type WorkspaceRemoteKind = 'workspace' | 'deploy';

type Pins = { [kind in WorkspaceRemoteKind]?: string };
type Record = { v: 1; workspaces: { [path: string]: Pins } };

export type WorkspaceRemotePins = {
    /** The repository identity (`host/owner/name`) pinned for this real folder path, or null. */
    pinned(path: string, kind: WorkspaceRemoteKind): Promise<string | null>;
    pin(path: string, kind: WorkspaceRemoteKind, identity: string): Promise<void>;
};

export function workspaceRemotePins(file: string): WorkspaceRemotePins {
    let workspaces: Map<string, Pins> | null = null;
    // Writes run one at a time, each over the latest record.
    let queue: Promise<unknown> = Promise.resolve();

    const load = async (): Promise<Map<string, Pins>> => {
        if (workspaces) return workspaces;
        const loaded = new Map<string, Pins>();
        try {
            const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<Record>;
            for (const [path, pins] of Object.entries(parsed?.workspaces ?? {})) {
                const kept: Pins = {};
                if (typeof pins?.workspace === 'string') kept.workspace = pins.workspace;
                if (typeof pins?.deploy === 'string') kept.deploy = pins.deploy;
                loaded.set(path, kept);
            }
        } catch (error) {
            // Missing on first use. A hand-edited file must not stop every workspace operation; an
            // empty record only means the next push asks the user again.
            if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
                logger.debug('[workspace-sync] remote pin record unreadable, starting empty', { error: String(error) });
            }
        }
        workspaces = loaded;
        return loaded;
    };

    const save = async (entries: Map<string, Pins>): Promise<void> => {
        const record: Record = { v: 1, workspaces: Object.fromEntries(entries) };
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, file);
    };

    return {
        async pinned(path, kind) {
            await queue;
            return (await load()).get(path)?.[kind] ?? null;
        },
        pin(path, kind, identity) {
            const next = queue.then(async () => {
                const entries = await load();
                entries.set(path, { ...entries.get(path), [kind]: identity });
                await save(entries);
            });
            queue = next.catch(() => undefined);
            return next;
        },
    };
}
