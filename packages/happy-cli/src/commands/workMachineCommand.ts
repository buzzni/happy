import { configuration } from '@/configuration';
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';
import {
    getWorkMachineDeviceId, openWorkMachineCredentials, prepareWorkMachineDevice, saveWorkMachineExecutionBinding,
    workMachineExecutionBindingSchema,
} from '@/daemon/workMachineCredential';
import { readCredentials, readSettings } from '@/persistence';

export async function handleWorkMachineCommand(args: string[]): Promise<void> {
    if (process.platform !== 'linux') throw new Error('Work machine migration requires a Linux Happy CLI host');
    const [operation, machineId, accountId, generation] = args;
    const { happyHomeDir, serverUrl } = configuration;
    if (operation === 'prepare' && machineId && args.length === 2) {
        const settings = await readSettings({ strict: true });
        if (settings.machineId && settings.machineId !== machineId) throw new Error('Another work machine is already configured in this home');
        if (await checkIfDaemonRunningAndCleanupStaleState()) throw new Error('Stop the Happy daemon before preparing the session inventory');
        console.log(JSON.stringify(await prepareWorkMachineDevice(happyHomeDir, machineId)));
        return;
    }
    if (operation !== 'bind' || args.length !== 4) {
        throw new Error('Usage: happy work-machine prepare <machineId> | bind <machineId> <accountId> <generation>');
    }

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
