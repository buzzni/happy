import type { MachineRunParameter, MachineRunProfile } from './machineRunProfile';

/**
 * Host-owned machine.run catalog for Moai v0.8.0 (buzzni/moai tag commit
 * ace3897f661b831ac4eca01f76dbe7e2c097c481). Extensions declare these
 * profiles verbatim; the daemon runs only what is listed here.
 *
 * Verified against the pinned binary under the daemon's restricted PATH:
 * reads degrade without git, writes resolve the actor through git config, and
 * the user config lives under HOME, so every profile allows HOME and a git
 * descendant. Writes change only `.moai/` (issues.jsonl, journal/).
 * `init`, `merge-driver`, `skill`, `hook`, `tui`, `--from` and `--wake` are
 * deliberately absent.
 */
const text = (maxLength: number): MachineRunParameter => ({ type: 'string', maxLength });

const base = {
    executable: 'moai',
    cwd: 'workspaceRoot',
    envAllowlist: ['HOME'],
    timeoutMs: 120_000,
    outputLimitBytes: 1_048_576,
    stdin: 'none',
    descendantAllowlist: ['git'],
} as const;

function read(name: string, argv: string[], parameters: Record<string, MachineRunParameter> = {}): MachineRunProfile {
    return { ...base, envAllowlist: [...base.envAllowlist], descendantAllowlist: [...base.descendantAllowlist], id: `buzzni.moai.${name}`, argv: ['--json', '-C', '{{workspaceRoot}}', ...argv], parameters };
}

function write(name: string, argv: string[], parameters: Record<string, MachineRunParameter>): MachineRunProfile {
    return { ...read(name, argv, parameters), writeScope: 'moai' };
}

export const MOAI_V080_MACHINE_RUN_PROFILES: readonly MachineRunProfile[] = [
    read('status', ['status']),
    read('ready', ['ready']),
    read('prime', ['prime']),
    read('show', ['show', '{{id}}'], { id: text(128) }),
    read('stats', ['stats']),
    read('wiki-ls', ['wiki', 'ls']),
    read('wiki-show', ['wiki', 'show', '{{slug}}'], { slug: text(128) }),
    write('add', ['add', '{{title}}'], { title: text(512) }),
    write('mv', ['mv', '{{id}}', '{{target}}'], { id: text(128), target: { type: 'string', maxLength: 32, values: ['todo', 'in_progress', 'review', 'done'] } }),
    write('edit', ['edit', '{{id}}', '--body', '{{body}}'], { id: text(128), body: text(4096) }),
    write('rm', ['rm', '{{id}}'], { id: text(128) }),
    write('note', ['note', '{{id}}', '{{note}}'], { id: text(128), note: text(4096) }),
    write('defer', ['defer', '{{id}}', '--msg', '{{msg}}'], { id: text(128), msg: text(4096) }),
    write('link', ['link', '{{id}}', '--blocks', '{{blocks}}'], { id: text(128), blocks: text(2048) }),
    write('backlog', ['backlog', 'add', '{{title}}'], { title: text(512) }),
];
