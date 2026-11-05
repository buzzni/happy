/**
 * Folders outside the daemon's allowed root that the machine owner approved on
 * this machine (aplus-dev-studio specs/approved-folder-roots). Saycode Desktop
 * running on the same machine writes the file after the owner picks the folder
 * in the OS folder dialog; nothing reachable over RPC adds to it except a
 * caller that can already write the happy home (compat file RPCs), which can
 * rewrite the machine credentials there anyway.
 *
 * Read on every call: the file is a few bytes and an approval or revocation
 * must apply to the running daemon without a restart.
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const APPROVED_FOLDERS_FILE = 'approved-folders.json';

export function readApprovedFolders(happyHomeDir: string): string[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(join(happyHomeDir, APPROVED_FOLDERS_FILE), 'utf8'));
    } catch {
        return [];
    }
    if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) return [];
    const folders = (parsed as { folders?: unknown }).folders;
    if (!Array.isArray(folders)) return [];
    return folders
        .filter((folder): folder is string => typeof folder === 'string' && isAbsolute(folder))
        .map((folder) => resolve(folder))
        // A drive or filesystem root would open the whole disk.
        .filter((folder) => dirname(folder) !== folder);
}
