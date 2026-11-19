import { trimIdent } from '@/utils/trimIdent';
import { setTimeout as delay } from 'node:timers/promises';

type ResumeThreadClient = {
    resumeThread: (opts: {
        threadId: string;
        cwd: string;
        mcpServers: Record<string, unknown>;
        developerInstructions?: string;
    }) => Promise<{ threadId: string; model: string }>;
};

type ResumeThreadSession = {
    updateMetadata: (handler: (currentMetadata: any) => any) => void;
    sendSessionEvent: (event: { type: 'message'; message: string }) => void;
};

type ResumeThreadMessageBuffer = {
    addMessage: (message: string, type: 'status') => void;
};

export async function resumeExistingThread(opts: {
    client: ResumeThreadClient;
    session: ResumeThreadSession;
    messageBuffer: ResumeThreadMessageBuffer;
    threadId: string;
    cwd: string;
    mcpServers: Record<string, unknown>;
    developerInstructions?: string;
    canRetry?: () => boolean;
}): Promise<{ threadId: string; model: string }> {
    try {
        const params = {
            threadId: opts.threadId,
            cwd: opts.cwd,
            mcpServers: opts.mcpServers,
            developerInstructions: opts.developerInstructions,
        };
        const resume = () => opts.client.resumeThread(params);
        const resumedThread = await resume().catch(async (error: unknown) => {
            // Only this definite pre-turn refusal is safe to repeat. Keep waiting local and short.
            if (!(error instanceof Error) || error.message !== `thread/resume: thread ${opts.threadId} already has an active writer (code=-32600)` || !opts.canRetry?.()) throw error;
            await delay(350);
            if (!opts.canRetry()) throw error;
            return resume();
        });

        opts.session.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            codexThreadId: resumedThread.threadId,
        }));
        opts.messageBuffer.addMessage(`Resumed thread ${trimIdent(resumedThread.threadId)}`, 'status');
        opts.session.sendSessionEvent({
            type: 'message',
            message: `Resumed Codex thread ${resumedThread.threadId}`,
        });

        return resumedThread;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to resume Codex thread ${opts.threadId}: ${reason}`);
    }
}
