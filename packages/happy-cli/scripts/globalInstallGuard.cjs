/**
 * Decide whether installing this workspace as the GLOBAL `happy` is safe.
 *
 * A global install rewrites the bundle that every running daemon watches. Each
 * one then hands itself over to the new copy, and every session it tracks is
 * moved onto a daemon it did not start with. Twice — 2026-08-23 and
 * 2026-08-25 — that handoff failed to produce a working daemon and the machine
 * sat without one for about six hours.
 *
 * The guard is deliberately narrow: it blocks only when there is something to
 * lose, i.e. a live daemon that is actually tracking sessions. A solo daemon
 * with no sessions is the normal development case; blocking that would make
 * this noise people learn to override without reading.
 */

function decideGlobalInstall({ state, isPidAlive, override }) {
    if (override) {
        return { blocked: false, overridden: true, sessionCount: 0, pid: null };
    }

    const sessionCount = state && Array.isArray(state.trackedSessions)
        ? state.trackedSessions.length
        : 0;
    const pid = state && typeof state.pid === 'number' ? state.pid : null;

    if (!pid || sessionCount === 0 || !isPidAlive(pid)) {
        return { blocked: false, overridden: false, sessionCount, pid };
    }

    return { blocked: true, overridden: false, sessionCount, pid };
}

// An unreadable Windows state may still belong to a live daemon. Never treat
// failed custody/decryption as absence and replace the bundle it is running.
function readInstallDaemonState({ filePath, isWindows, fs = require('node:fs'), loadWindowsStorage }) {
    try {
        if (isWindows) {
            fs.lstatSync(filePath); // permits a new install without an existing helper
            return JSON.parse(loadWindowsStorage().read(filePath));
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        if (!isWindows || error.code === 'ENOENT') return null;
        throw new Error('WINDOWS_SECRET_READ_FAILED: build the paired Windows storage helper before verifying a global install');
    }
}
module.exports = { decideGlobalInstall, readInstallDaemonState };
