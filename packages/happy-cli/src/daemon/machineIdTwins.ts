import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Copied daemon homes (e.g. `~/.happy_remote2_backup`) keep the machine id. A daemon
 * started from a copy then registers as the same machine and the two overwrite each
 * other's caller-grant key, which surfaces only as `invalid-envelope` far away.
 */
export function findMachineIdTwins(input: {
    homeDir: string;
    machineId: string;
    siblings: Array<{ dir: string; settingsJson: string | null }>;
}): string[] {
    return input.siblings.flatMap(({ dir, settingsJson }) => {
        if (dir === input.homeDir || settingsJson === null) return [];
        try {
            return (JSON.parse(settingsJson) as { machineId?: unknown }).machineId === input.machineId ? [dir] : [];
        } catch {
            return [];
        }
    });
}

/** Diagnostic only: an unreadable directory yields no twins rather than failing startup. */
export function listMachineIdTwins(homeDir: string, machineId: string): string[] {
    const parent = dirname(homeDir);
    let names: string[];
    try {
        names = readdirSync(parent);
    } catch {
        return [];
    }
    const siblings = names
        .filter((name) => name.startsWith('.happy') && name !== basename(homeDir))
        .map((name) => {
            const dir = join(parent, name);
            try {
                return { dir, settingsJson: readFileSync(join(dir, 'settings.json'), 'utf8') };
            } catch {
                return { dir, settingsJson: null };
            }
        });
    return findMachineIdTwins({ homeDir, machineId, siblings });
}
