import { open } from 'node:fs/promises'

/** Makes a rename in `dir` durable. Windows directory handles do not support Node's fsync;
 * there the file's own sync and the rename still apply. */
export async function syncDirectory(dir: string): Promise<void> {
    if (process.platform === 'win32') return
    const handle = await open(dir, 'r')
    try { await handle.sync() } finally { await handle.close() }
}
