import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';

type CodexSteerRpcResult = { success: true } | { success: false; error: string };
type CodexSteerRpcHandler = (params: Record<string, unknown>) => Promise<CodexSteerRpcResult>;

type CodexSteerHandlerInput = {
    client: {
        steerTurn(text: string): Promise<void>;
    };
    session: {
        rpcHandlerManager: {
            registerHandler(method: string, handler: CodexSteerRpcHandler): void;
        };
        sendSessionProtocolMessage(envelope: SessionEnvelope): void;
    };
    onFailure(message: string): void;
};

export function registerCodexSteerHandler(input: CodexSteerHandlerInput): void {
    input.session.rpcHandlerManager.registerHandler('steer', async (params) => {
        const text = typeof params?.text === 'string' ? params.text : '';
        if (!text.trim()) {
            return { success: false, error: 'Steer text is required' };
        }

        try {
            await input.client.steerTurn(text);
            input.session.sendSessionProtocolMessage(createEnvelope('user', { t: 'text', text }));
            return { success: true };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            input.onFailure(message);
            return { success: false, error: message };
        }
    });
}
