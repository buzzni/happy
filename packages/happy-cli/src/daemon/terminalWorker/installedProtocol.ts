/**
 * Does the installed bundle speak this daemon's worker protocol? (specs/terminal-survive-runner-restart
 * HR5) Asked before a restart keeps terminals: the daemon that starts next runs from the installed
 * files and adopts only workers of its own protocol.
 *
 * Read from the installed `package.json` (`happyTerminalWorkerProtocol`) rather than by running the
 * installed CLI: a bundle from before workers would take an unknown subcommand for a session to
 * start. A missing or unreadable field is a no.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectPath } from '@/projectPath'
import { TERMINAL_WORKER_PROTOCOL_VERSION } from './protocol'

export const INSTALLED_PROTOCOL_FIELD = 'happyTerminalWorkerProtocol'

export function installedWorkerProtocolMatches(root: string = projectPath()): boolean {
    try {
        const installed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
        return installed[INSTALLED_PROTOCOL_FIELD] === TERMINAL_WORKER_PROTOCOL_VERSION
    } catch {
        return false
    }
}
