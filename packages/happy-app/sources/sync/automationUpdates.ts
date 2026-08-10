export interface AutomationUpdate {
    projectId: string | null;
    automationId?: string;
    runId?: string;
    revision?: number;
    generation?: number;
    reason: 'viewer-key' | 'machine-key' | 'upsert' | 'delete' | 'sync' | 'run';
}

const listeners = new Set<(update: AutomationUpdate) => void>();

export function subscribeAutomationUpdates(listener: (update: AutomationUpdate) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function emitAutomationUpdate(update: AutomationUpdate): void {
    for (const listener of listeners) listener(update);
}
