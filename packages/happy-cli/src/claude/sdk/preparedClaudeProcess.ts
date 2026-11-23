import { addAbortListener } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { prewarm, type ClaimOptions, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

type ClaimInput = {
    options: ClaimOptions;
    prompt: AsyncIterable<SDKUserMessage>;
    mcpServers?: Options['mcpServers'];
    requiredMcp?: readonly string[];
    allowTool?: Options['canUseTool'];
    verifyClaim?: (query: Query) => Promise<void>;
    signal?: AbortSignal;
};

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const listener = addAbortListener(signal, () => reject(signal.reason));
        void work.then(value => {
            listener[Symbol.dispose]();
            resolve(value);
        }, error => {
            listener[Symbol.dispose]();
            reject(error);
        });
    });
}

/** One spare owned by the draft worker. The caller supplies the verified startup options. */
export async function prepareClaudeProcess(options: Omit<Options, 'mcpServers' | 'canUseTool'>) {
    let decideTool: Options['canUseTool'];
    const spare = await prewarm({
        initializeTimeoutMs: 12_000,
        options: {
            ...options,
            canUseTool: async (...args) => decideTool?.(...args) ?? { behavior: 'deny', message: 'Claude draft is not active' },
        },
    });
    // An unused spare can exit before there is a consumer of its claim promise.
    void spare.claimed.catch(() => {});
    const closed = new AbortController();
    let used = false;
    let disposal: Promise<void> | undefined;
    let abortOwner: Disposable | undefined;
    const exited = () => {
        abortOwner?.[Symbol.dispose]();
        decideTool = undefined;
        closed.abort(new Error('Prepared Claude process closed'));
    };
    void spare.exited.then(exited, exited);
    function dispose(): Promise<void> {
        if (!disposal) {
            exited();
            spare.close();
            disposal = untilAborted(spare.exited, AbortSignal.timeout(5_000)).catch(() => {
                throw Object.assign(new Error('Prepared Claude process exit unconfirmed'), { code: 'CLAUDE_PREPARED_EXIT_UNCONFIRMED' });
            });
        }
        return disposal;
    }

    return {
        dispose,
        async claim(input: ClaimInput): Promise<Query> {
            if (used || closed.signal.aborted) throw new Error('Prepared Claude process unavailable');
            used = true;
            const deadline = AbortSignal.any([closed.signal, AbortSignal.timeout(10_000), ...(input.signal ? [input.signal] : [])]);
            let release!: (canRead: boolean) => void;
            const gate = new Promise<boolean>(resolve => { release = resolve; });
            async function* stagedPrompt() {
                if (await gate) yield* input.prompt;
            }
            try {
                deadline.throwIfAborted();
                const required = input.requiredMcp ?? [];
                if (required.some(name => !input.mcpServers || !Object.hasOwn(input.mcpServers, name))) {
                    throw new Error('Required Claude MCP was not supplied');
                }
                if (input.signal) abortOwner = addAbortListener(input.signal, () => { void dispose().catch(() => {}); });
                const query = spare.claim({ options: input.options, prompt: stagedPrompt() });
                await untilAborted(spare.claimed, deadline);
                if (input.verifyClaim) await untilAborted(input.verifyClaim(query), deadline);
                if (input.mcpServers) {
                    const result = await untilAborted(query.setMcpServers(input.mcpServers), deadline);
                    if (required.some(name => Object.hasOwn(result.errors, name))) throw new Error('Required Claude MCP setup failed');
                    if (required.length > 0) {
                        while (true) {
                            deadline.throwIfAborted();
                            const servers = await untilAborted(query.mcpServerStatus(), deadline);
                            const states = required.map(name => servers.find(server => server.name === name)?.status);
                            if (states.every(state => state === 'connected')) break;
                            if (states.some(state => state === 'failed' || state === 'needs-auth' || state === 'disabled')) {
                                throw new Error('Required Claude MCP is unavailable');
                            }
                            await delay(50, undefined, { signal: deadline });
                        }
                    }
                }
                deadline.throwIfAborted();
                decideTool = input.allowTool;
                release(true);
                return query;
            } catch (error) {
                release(false);
                await dispose();
                throw error;
            }
        },
    };
}
