/** The daemon's own registration for an owned spawn (T4rt), re-read on every use. Never a descriptor's claims. */
export async function readOwnedRegistration<C>(input: { machineId: string; credentials: C; epoch: string;
    readCredentials(): Promise<C | null>; readSettings(): Promise<{ machineId?: string; machineIdConfirmedByServer?: boolean }> }) {
    const [current, settings] = await Promise.all([input.readCredentials(), input.readSettings()]);
    if (!current || settings.machineId !== input.machineId || !settings.machineIdConfirmedByServer) throw new Error('identity-changed');
    // Never replace the running daemon's registration with a descriptor's claims.
    if (JSON.stringify(current) !== JSON.stringify(input.credentials)) throw new Error('identity-changed');
    return { machineId: input.machineId, credentials: current, epoch: input.epoch };
}
