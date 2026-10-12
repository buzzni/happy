import { join } from 'node:path';
import type { MachineRunManagedTools, MachineRunParameter, MachineRunProfile } from './machineRunProfile';
import type { ManagedMachineTool } from './managedMachineTool';

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

/**
 * The pinned v0.8.0 release artifacts. Archive and extracted-executable
 * digests were checked against the public release assets.
 */
export const MOAI_V080_MANAGED_TOOL: ManagedMachineTool = {
    id: 'buzzni.moai',
    version: '0.8.0',
    executable: 'moai',
    artifacts: {
        'darwin-arm64': {
            url: 'https://github.com/buzzni/moai/releases/download/v0.8.0/moai-v0.8.0-aarch64-apple-darwin.tar.gz',
            sha256: 'c79200aa0b10b5949efa19a1c280465a1db5c3d6163f4e8b27f979b7403edeb2',
            archiveRoot: 'moai-v0.8.0-aarch64-apple-darwin',
            executableSha256: '81c2102d4326d1be8b622ec66dd191596fe38d54aae78bf9b8eec58b247b5e6e',
        },
        'linux-x64': {
            url: 'https://github.com/buzzni/moai/releases/download/v0.8.0/moai-v0.8.0-x86_64-unknown-linux-musl.tar.gz',
            sha256: '9c1db13a9a589c9dfcdc5645f757734e2fbc2eda7674a9f2d8662b2fb8d4c3e5',
            archiveRoot: 'moai-v0.8.0-x86_64-unknown-linux-musl',
            executableSha256: '7cb0ee09e1159ab2b19d1102db7bb3d5c41ddca0d4781707944c3781747d15e6',
        },
    },
};

/** Managed tools this daemon build installs under `<happyHome>/managed-tools`. */
export function hostManagedMachineTools(happyHomeDir: string): MachineRunManagedTools {
    return { root: join(happyHomeDir, 'managed-tools'), tools: [MOAI_V080_MANAGED_TOOL] };
}
