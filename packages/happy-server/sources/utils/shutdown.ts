import { log } from "./log";

const shutdownHandlers = new Map<string, Array<() => Promise<void>>>();
const shutdownController = new AbortController();

export const shutdownSignal = shutdownController.signal;

export function onShutdown(name: string, callback: () => Promise<void>): () => void {
    if (shutdownSignal.aborted) {
        // If already shutting down, execute immediately
        callback();
        return () => {};
    }
    
    if (!shutdownHandlers.has(name)) {
        shutdownHandlers.set(name, []);
    }
    const handlers = shutdownHandlers.get(name)!;
    handlers.push(callback);
    
    // Return unsubscribe function
    return () => {
        const index = handlers.indexOf(callback);
        if (index !== -1) {
            handlers.splice(index, 1);
            if (handlers.length === 0) {
                shutdownHandlers.delete(name);
            }
        }
    };
}

export function isShutdown() {
    return shutdownSignal.aborted;
}

export async function awaitShutdown(control?: { requested: Promise<void>; finalize?: () => Promise<void> }) {
    let requested!: () => void;
    const signal = new Promise<void>((resolve) => { requested = resolve; });
    // Keep handling repeated signals until drain finishes; otherwise the OS can
    // terminate the process before its database work has settled.
    process.on('SIGINT', requested);
    process.on('SIGTERM', requested);
    try {
        await (control ? Promise.race([signal, control.requested]) : signal);
        await drainShutdownHandlers(control !== undefined);
        await control?.finalize?.();
    } finally {
        process.off('SIGINT', requested);
        process.off('SIGTERM', requested);
    }
}

async function drainShutdownHandlers(controlled: boolean) {
    shutdownController.abort();
    
    // Copy handlers to avoid race conditions
    const handlersSnapshot = new Map<string, Array<() => Promise<void>>>();
    for (const [name, handlers] of shutdownHandlers) {
        handlersSnapshot.set(name, [...handlers]);
    }
    
    // Controlled standalone must drain users of the database before disconnecting it.
    const databaseHandlers = controlled ? handlersSnapshot.get("db") ?? [] : [];
    if (controlled) handlersSnapshot.delete("db");

    // Execute independent shutdown handlers concurrently
    const allHandlers: Promise<void>[] = [];
    let totalHandlers = 0;
    const failures: unknown[] = [];
    
    for (const [name, handlers] of handlersSnapshot) {
        totalHandlers += handlers.length;
        log(`Starting ${handlers.length} shutdown handlers for: ${name}`);
        
        handlers.forEach((handler, index) => {
            const handlerPromise = Promise.resolve().then(handler).then(
                () => {},
                (error) => { failures.push(error); log(`Error in shutdown handler ${name}[${index}]:`, error); }
            );
            allHandlers.push(handlerPromise);
        });
    }
    
    if (totalHandlers > 0) {
        log(`Waiting for ${totalHandlers} shutdown handlers to complete...`);
        const startTime = Date.now();
        await Promise.all(allHandlers);
        const duration = Date.now() - startTime;

        log(`All ${totalHandlers} shutdown handlers completed in ${duration}ms`);
    }
    await Promise.all(databaseHandlers.map(async (handler) => {
        try { await handler(); } catch (error) { failures.push(error); log("Error disconnecting database:", error); }
    }));
    if (controlled && failures.length) throw new AggregateError(failures, "Standalone shutdown failed");
}

export async function keepAlive<T>(name: string, callback: () => Promise<T>): Promise<T> {
    let completed = false;
    let result: T;
    let error: any;
    
    const promise = new Promise<void>((resolve) => {
        const unsubscribe = onShutdown(`keepAlive:${name}`, async () => {
            if (!completed) {
                log(`Waiting for keepAlive operation to complete: ${name}`);
                await promise;
            }
        });
        
        // Run the callback
        callback().then(
            (res) => {
                result = res;
                completed = true;
                unsubscribe();
                resolve();
            },
            (err) => {
                error = err;
                completed = true;
                unsubscribe();
                resolve();
            }
        );
    });
    
    // Wait for completion
    await promise;
    
    if (error) {
        throw error;
    }
    
    return result!;
}
