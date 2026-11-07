import { resolve } from 'node:path';
import type { QueryOptions } from '../sdk/types';

/**
 * The plugin directories a person gave Claude on the command line
 * (`happy claude -- --plugin-dir <dir>`), as the SDK `plugins` option.
 *
 * The terminal launcher hands these arguments to Claude itself; the SDK
 * runner does not, so without this a remote session silently loses them.
 * Only `--plugin-dir` is mapped: other CLI flags must not override the
 * options the runner sets. Reading stops at `--`. Relative paths resolve
 * against the session path, which a daemon-spawned runner's cwd need not be.
 */
export function pluginsFromArgs(args: readonly string[] = [], cwd: string): QueryOptions['plugins'] {
    const plugins: NonNullable<QueryOptions['plugins']> = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') break;
        let path: string;
        if (arg === '--plugin-dir') {
            const next = args[++i];
            if (next === undefined || next.startsWith('-')) {
                throw new Error('--plugin-dir requires a path');
            }
            path = next;
        } else if (arg.startsWith('--plugin-dir=')) {
            path = arg.slice('--plugin-dir='.length);
        } else {
            continue;
        }
        if (!path || path.includes('\0')) {
            throw new Error('--plugin-dir requires a non-empty path without null bytes');
        }
        plugins.push({ type: 'local', path: resolve(cwd, path) });
    }
    return plugins.length > 0 ? plugins : undefined;
}
