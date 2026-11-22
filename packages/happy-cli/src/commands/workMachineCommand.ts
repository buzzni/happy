import { homedir } from 'node:os';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';
import {
    getWorkMachineDeviceId, openWorkMachineCredentials, prepareWorkMachineDevice, saveWorkMachineExecutionBinding,
    workMachineExecutionBindingSchema,
} from '@/daemon/workMachineCredential';
import {
    createWorkMachineRestoreProof, createWorkMachineTargetApproval, exportWorkMachine, importWorkMachine,
} from '@/daemon/workMachineMigration';
import { readCredentials, readSettings, updateSettings } from '@/persistence';

const USAGE = [
    'Usage: happy work-machine prepare <machineId>',
    '       happy work-machine bind <machineId> <accountId> <generation>',
    '       happy work-machine target-approval <machineId> <jobId> <expiresAt> --account <accountId> --generation <n> --source-device <deviceId> [--max-bytes <n>]',
    '       happy work-machine export --studio <url> --job <jobId> --token <wmt_…>',
    '       happy work-machine import --studio <url> --job <jobId> --token <wmt_…>',
    '       happy work-machine restore-proof <machineId> <generation>',
].join('\n');
/** The envelope's single-archive ceiling. */
const MAX_ARCHIVE_BYTES = 32 * 1024 ** 3;

/** Positional arguments and `--name value` options; anything else is a usage error. */
function parseArguments(args: string[], allowed: string[]): { positional: string[]; options: Record<string, string> } {
    const positional: string[] = [];
    const options: Record<string, string> = {};
    for (let index = 0; index < args.length; index += 1) {
        const name = args[index].startsWith('--') ? args[index].slice(2) : null;
        if (name === null) { positional.push(args[index]); continue; }
        const value = args[index + 1];
        if (!allowed.includes(name) || value === undefined || name in options) throw new Error(USAGE);
        options[name] = value;
        index += 1;
    }
    return { positional, options };
}

const positiveInteger = (value: string | undefined) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(USAGE);
    return parsed;
};

async function requireStoppedDaemon(action: string): Promise<void> {
    if (await checkIfDaemonRunningAndCleanupStaleState()) throw new Error(`Stop the Happy daemon before ${action}`);
}

const providerHomes = () => ({
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    codexHome: process.env.CODEX_HOME || join(homedir(), '.codex'),
});

export async function handleWorkMachineCommand(args: string[]): Promise<void> {
    if (process.platform !== 'linux') throw new Error('Work machine migration requires a Linux Happy CLI host');
    const [operation, machineId, accountId, generation] = args;
    const rest = args.slice(1);
    const { happyHomeDir, serverUrl } = configuration;
    if (operation === 'prepare' && machineId && args.length === 2) {
        const settings = await readSettings({ strict: true });
        if (settings.machineId && settings.machineId !== machineId) throw new Error('Another work machine is already configured in this home');
        if (await checkIfDaemonRunningAndCleanupStaleState()) throw new Error('Stop the Happy daemon before preparing the session inventory');
        console.log(JSON.stringify(await prepareWorkMachineDevice(happyHomeDir, machineId)));
        return;
    }
    if (operation === 'target-approval') {
        const { positional, options } = parseArguments(rest, ['account', 'generation', 'source-device', 'max-bytes']);
        const [targetMachineId, jobId, expiresAt] = positional;
        if (positional.length !== 3 || !options.account || !options['source-device']) throw new Error(USAGE);
        const settings = await readSettings({ strict: true });
        if (settings.machineId && settings.machineId !== targetMachineId) throw new Error('Another work machine is already configured in this home');
        const expiry = /^\d+$/.test(expiresAt) ? Number(expiresAt) : Date.parse(expiresAt);
        console.log(JSON.stringify(await createWorkMachineTargetApproval({
            home: happyHomeDir, machineId: targetMachineId, jobId, accountId: options.account,
            generation: positiveInteger(options.generation), sourceDeviceId: options['source-device'],
            expiresAt: positiveInteger(String(expiry)),
            maxBytes: options['max-bytes'] ? positiveInteger(options['max-bytes']) : MAX_ARCHIVE_BYTES,
        })));
        return;
    }
    if (operation === 'export' || operation === 'import') {
        const { positional, options } = parseArguments(rest, ['studio', 'job', 'token']);
        if (positional.length || !options.studio || !options.job || !options.token) throw new Error(USAGE);
        await requireStoppedDaemon(operation === 'export' ? 'exporting this work machine' : 'importing a work machine');
        const endpoint = { home: happyHomeDir, studioUrl: options.studio, jobId: options.job, token: options.token, ...providerHomes() };
        if (operation === 'export') {
            console.log(JSON.stringify(await exportWorkMachine(endpoint)));
            return;
        }
        const imported = await importWorkMachine(endpoint);
        await updateSettings(current => {
            if (current.machineId && current.machineId !== imported.machineId) throw new Error('Another work machine is already configured in this home');
            return { ...current, machineId: imported.machineId };
        }, { strict: true });
        console.log(JSON.stringify(imported));
        return;
    }
    if (operation === 'restore-proof' && args.length === 3) {
        const restoreGeneration = positiveInteger(args[2]);
        await requireStoppedDaemon('rotating the machine data key');
        console.log(JSON.stringify(await createWorkMachineRestoreProof({ home: happyHomeDir, machineId, generation: restoreGeneration })));
        return;
    }
    if (operation !== 'bind' || args.length !== 4) throw new Error(USAGE);

    const [settings, credentials] = await Promise.all([readSettings({ strict: true }), readCredentials()]);
    if (settings.machineId !== machineId || credentials?.encryption.type !== 'dataKey') {
        throw new Error('The registered machine and its data key must already exist in this home');
    }
    if (await checkIfDaemonRunningAndCleanupStaleState()) throw new Error('Stop the Happy daemon before applying an execution binding');
    const binding = workMachineExecutionBindingSchema.parse({
        machineId, accountId, generation: Number(generation),
        deviceId: await getWorkMachineDeviceId(happyHomeDir, machineId),
        serverOrigin: new URL(serverUrl).origin,
    });
    const device = await openWorkMachineCredentials(happyHomeDir, serverUrl, binding);
    await device.renew();
    await saveWorkMachineExecutionBinding(happyHomeDir, binding);
    console.log(JSON.stringify(binding));
}
