type MachineLookup = {
    machine: {
        findFirst(args: {
            where: { accountId: string; id: string };
            select: { id: true };
        }): Promise<{ id: string } | null>;
    };
};

export async function machineSocketIdentityExists(
    db: MachineLookup,
    accountId: string,
    machineId: string,
): Promise<boolean> {
    const machine = await db.machine.findFirst({
        where: { accountId, id: machineId },
        select: { id: true },
    });
    return machine !== null;
}
