import type { AxState, AxStep } from './schema';
import { bootstrapWorkspace } from './bootstrap';
import { readState } from './io';
import { applyTransition } from '../transitions';

export async function persistExplicitStep(
    workspaceRoot: string,
    step: AxStep,
): Promise<AxState> {
    try {
        const current = await readState(workspaceRoot);
        if (current.step === step) return current;
        return applyTransition(workspaceRoot, step);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await bootstrapWorkspace(workspaceRoot, step);
        return readState(workspaceRoot);
    }
}
