import { join } from 'node:path';
import type { MachineRunManagedTools, MachineRunParameter, MachineRunProfile } from './machineRunProfile';
import type { ManagedMachineTool } from './managedMachineTool';

/**
 * Host-owned Moai catalog. Existing write operations remain available to old
 * extensions; the additional reads match Moai extension 2.0.0 verbatim.
 * The managed CLI is pinned independently to the verified v0.17.0 release.
 * Skill installation is deliberately absent: v0.17.0 does not accept the
 * extension's --hook-exe option. Never advertise an operation it cannot run.
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

export const MOAI_MACHINE_RUN_PROFILES: readonly MachineRunProfile[] = [
    read('status', ['status']),
    read('ready', ['ready']),
    read('prime', ['prime']),
    read('show', ['show', '{{id}}'], { id: text(128) }),
    read('stats', ['stats']),
    read('wiki-ls', ['wiki', 'ls']),
    read('wiki-show', ['wiki', 'show', '{{slug}}'], { slug: text(128) }),
    read('show-all', ['show', '--all']),
    read('backlog-all', ['backlog', 'show', '--all']),
    read('show-archived', ['show', '--archived', '-n', '200', '--sort', 'id']),
    read('show-archived-after', ['show', '--archived', '-n', '200', '--sort', 'id', '--after', '{{after}}'], { after: text(128) }),
    // These write only the user's personal read marks, never the project tracker.
    read('read', ['read', '{{id}}'], { id: text(128) }),
    read('read-all', ['read', '--all']),
    read('read-group', ['read', '-e', '{{group}}'], { group: text(128) }),
    read('skill-status', ['skill', 'status']),
    read('show-all-worktree', ['show', '--all', '--worktree']),
    read('show-worktree', ['show', '{{id}}', '--worktree'], { id: text(128) }),
    write('add', ['add', '{{title}}'], { title: text(512) }),
    write('mv', ['mv', '{{id}}', '{{target}}'], { id: text(128), target: { type: 'string', maxLength: 32, values: ['todo', 'in_progress', 'review', 'done'] } }),
    write('edit', ['edit', '{{id}}', '--body', '{{body}}'], { id: text(128), body: text(4096) }),
    write('rm', ['rm', '{{id}}'], { id: text(128) }),
    write('note', ['note', '{{id}}', '{{note}}'], { id: text(128), note: text(4096) }),
    write('defer', ['defer', '{{id}}', '--msg', '{{msg}}'], { id: text(128), msg: text(4096) }),
    write('link', ['link', '{{id}}', '--blocks', '{{blocks}}'], { id: text(128), blocks: text(2048) }),
    write('backlog', ['backlog', 'add', '{{title}}'], { title: text(512) }),
];

/**
 * The pinned v0.17.0 release artifacts. Archive and extracted-executable
 * digests were checked against the public release assets.
 */
export const MOAI_MANAGED_TOOL: ManagedMachineTool = {
    id: 'buzzni.moai',
    version: '0.17.0',
    executable: 'moai',
    artifacts: {
        'darwin-arm64': {
            url: 'https://github.com/buzzni/moai/releases/download/v0.17.0/moai-v0.17.0-aarch64-apple-darwin.tar.gz',
            sha256: '89364d0f9ca19bcd054b2a87f000d50bd0971c86a5f183e5d12355b20def4e01',
            archiveRoot: 'moai-v0.17.0-aarch64-apple-darwin',
            executableSha256: 'ebda55033dae9c10f3e8c488a14617a6cdca010329d2a9e71391406f8ea035a3',
        },
        'linux-x64': {
            url: 'https://github.com/buzzni/moai/releases/download/v0.17.0/moai-v0.17.0-x86_64-unknown-linux-musl.tar.gz',
            sha256: '6906d3e045844feca31b75f2a416bd80db0d7a28a970782444d7f5d7ec7ce1db',
            archiveRoot: 'moai-v0.17.0-x86_64-unknown-linux-musl',
            executableSha256: 'e025a79af0a4cead969d0003b1a597d165dd72a4db04ed28b2840f538facd043',
        },
    },
};

/** Managed tools this daemon build installs under `<happyHome>/managed-tools`. */
export function hostManagedMachineTools(happyHomeDir: string): MachineRunManagedTools {
    return { root: join(happyHomeDir, 'managed-tools'), tools: [MOAI_MANAGED_TOOL] };
}
