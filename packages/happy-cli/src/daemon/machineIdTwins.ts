import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
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

/** A settings file is a few hundred bytes; anything larger, or not a regular file, is not read at startup. */
const MAX_SETTINGS_BYTES = 64 * 1024;

/** Diagnostic only: an unreadable directory yields no twins rather than failing startup. */
export function listMachineIdTwins(homeDir: string, machineId: string): string[] {
    let home: string;
    let entries: import('node:fs').Dirent[];
    try {
        home = realpathSync(homeDir);
        entries = readdirSync(dirname(home), { withFileTypes: true });
    } catch {
        return [];
    }
    const parent = dirname(home);
    const siblings = entries
        // Real directories only: a symlink can point anywhere and is not a copied home.
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('.happy') && entry.name !== basename(home))
        .map((entry) => {
            const dir = join(parent, entry.name);
            const file = join(dir, 'settings.json');
            try {
                const stat = lstatSync(file);
                if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return { dir, settingsJson: null };
                return { dir, settingsJson: readFileSync(file, 'utf8') };
            } catch {
                return { dir, settingsJson: null };
            }
        });
    return findMachineIdTwins({ homeDir: home, machineId, siblings });
}
