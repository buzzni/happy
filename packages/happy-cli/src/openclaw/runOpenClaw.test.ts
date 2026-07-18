import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let userMessageHandler: ((message: any) => void) | null = null;
  let killHandler: (() => Promise<void>) | null = null;

  const mockSession = {
    on: vi.fn(),
    onUserMessage: vi.fn((handler: (message: any) => void) => {
      userMessageHandler = handler;
    }),
    keepAlive: vi.fn(),
    sendSessionProtocolMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
    updateMetadata: vi.fn(),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => { }),
    close: vi.fn(async () => { }),
    updateAgentState: vi.fn((handler: (state: Record<string, unknown>) => Record<string, unknown>) => {
      handler({});
    }),
    rpcHandlerManager: { registerHandler: vi.fn() },
  };

  const backendState = {
    listeners: [] as Array<(message: any) => void>,
    prompts: [] as string[],
    cancelCalls: [] as string[],
    disposeCalls: 0,
    /** Prompts whose sendPrompt should reject, simulating a dropped gateway. */
    failPromptsMatching: null as string | null,
  };

  return {
    mockReadSettings: vi.fn(async () => ({ machineId: 'machine-1', sandboxConfig: undefined })),
    mockApiCreate: vi.fn(),
    mockGetOrCreateMachine: vi.fn(async () => ({})),
    mockGetOrCreateSession: vi.fn(async () => ({ id: 'session-1' })),
    mockSetupOfflineReconnection: vi.fn(),
    mockNotifyDaemonSessionStarted: vi.fn(async () => ({ error: null })),
    mockSetBackend: vi.fn(),
    mockKillRegister: vi.fn((_rpc: unknown, handler: () => Promise<void>) => {
      killHandler = handler;
    }),
    mockLoggerDebug: vi.fn(),
    getUserMessageHandler: () => userMessageHandler,
    setUserMessageHandler: (handler: ((message: any) => void) | null) => {
      userMessageHandler = handler;
    },
    getKillHandler: () => killHandler,
    setKillHandler: (handler: (() => Promise<void>) | null) => {
      killHandler = handler;
    },
    mockSession,
    backendState,
  };
});

vi.mock('@/persistence', async () => {
  const actual = await vi.importActual<typeof import('@/persistence')>('@/persistence');
  return { ...actual, readSettings: mocks.mockReadSettings };
});

vi.mock('@/api/api', () => ({
  ApiClient: { create: mocks.mockApiCreate },
}));

vi.mock('@/daemon/run', () => ({
  initialMachineMetadata: {
    host: 'host', platform: 'darwin', happyCliVersion: 'test',
    homeDir: '/tmp', happyHomeDir: '/tmp/.happy', happyLibDir: '/tmp/happy',
  },
}));

vi.mock('@/utils/setupOfflineReconnection', () => ({
  setupOfflineReconnection: mocks.mockSetupOfflineReconnection,
}));

vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonSessionStarted: mocks.mockNotifyDaemonSessionStarted,
}));

vi.mock('@/claude/registerKillSessionHandler', () => ({
  registerKillSessionHandler: mocks.mockKillRegister,
}));

vi.mock('@/utils/serverConnectionErrors', () => ({
  connectionState: { setBackend: mocks.mockSetBackend },
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: mocks.mockLoggerDebug },
}));

vi.mock('./OpenClawBackend', () => ({
  OpenClawBackend: class MockOpenClawBackend {
    onMessage(handler: (message: any) => void) {
      mocks.backendState.listeners.push(handler);
    }

    offMessage(handler: (message: any) => void) {
      mocks.backendState.listeners = mocks.backendState.listeners.filter((item) => item !== handler);
    }

    async startSession() {
      return { sessionId: 'openclaw-session-1' };
    }

    async sendPrompt(_sessionId: string, prompt: string) {
      mocks.backendState.prompts.push(prompt);
      const failMatch = mocks.backendState.failPromptsMatching;
      if (failMatch !== null && prompt.includes(failMatch)) {
        throw new Error('Not connected to OpenClaw gateway');
      }
    }

    async cancel(sessionId: string) {
      mocks.backendState.cancelCalls.push(sessionId);
      await Promise.resolve();
      for (const listener of mocks.backendState.listeners) {
        listener({ type: 'status', status: 'stopped' });
      }
    }

    async dispose() {
      mocks.backendState.disposeCalls += 1;
    }
  },
}));

import { runOpenClaw } from './runOpenClaw';

const emit = (msg: any) => {
  for (const listener of mocks.backendState.listeners) {
    listener(msg);
  }
};

const startRunner = (turnInactivityTimeoutMs: number) => runOpenClaw({
  credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
  gatewayUrl: 'ws://127.0.0.1:9999',
  gatewayToken: 'gateway-token',
  turnInactivityTimeoutMs,
});

describe('runOpenClaw turn inactivity watchdog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setUserMessageHandler(null);
    mocks.setKillHandler(null);
    mocks.backendState.listeners = [];
    mocks.backendState.prompts = [];
    mocks.backendState.cancelCalls = [];
    mocks.backendState.disposeCalls = 0;
    mocks.backendState.failPromptsMatching = null;

    mocks.mockApiCreate.mockResolvedValue({
      getOrCreateMachine: mocks.mockGetOrCreateMachine,
      getOrCreateSession: mocks.mockGetOrCreateSession,
    });
    mocks.mockSetupOfflineReconnection.mockImplementation(() => ({
      session: mocks.mockSession,
      reconnectionHandle: { cancel: vi.fn() },
      isOffline: false,
    }));
  });

  const sendPrompt = async (text: string) => {
    const before = mocks.backendState.prompts.length;
    mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text } });
    await vi.waitFor(() => {
      expect(mocks.backendState.prompts.length).toBeGreaterThan(before);
    });
  };

  it('cancels the backend when a turn goes silent for the inactivity window', async () => {
    const runPromise = startRunner(200);
    const settled = runPromise.then(() => null).catch((error: Error) => error);

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });
    await sendPrompt('hang please');

    await vi.waitFor(() => {
      expect(mocks.backendState.cancelCalls).toContain('openclaw-session-1');
    });

    await mocks.getKillHandler()!();
    await settled;
  });

  it('keeps a slow turn alive while the backend keeps reporting activity', async () => {
    const runPromise = startRunner(1000);
    const settled = runPromise.then(() => null).catch((error: Error) => error);

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });
    await sendPrompt('long but alive');

    // Total elapsed exceeds the window, but no single gap does.
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      emit({ type: 'model-output', textDelta: `chunk-${i}` });
    }

    expect(mocks.backendState.cancelCalls).not.toContain('openclaw-session-1');

    await mocks.getKillHandler()!();
    await settled;
  });

  // Regression: sendPrompt can reject before the turn promise is ever awaited.
  // The abandoned turn's watchdog used to stay armed, and once a later turn
  // replaced pendingTurn nothing re-armed it — so it eventually fired and
  // cancelled a healthy, actively streaming turn.
  it('does not cancel a later healthy turn after a failed send abandons a turn', async () => {
    const runPromise = startRunner(300);
    const settled = runPromise.then(() => null).catch((error: Error) => error);

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.backendState.failPromptsMatching = 'doomed';
    await sendPrompt('doomed turn');
    await vi.waitFor(() => {
      expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    });

    // Second turn stays busy well past the window the abandoned turn was armed for.
    mocks.backendState.failPromptsMatching = null;
    await sendPrompt('healthy turn');
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      emit({ type: 'model-output', textDelta: `chunk-${i}` });
    }

    expect(mocks.backendState.cancelCalls).not.toContain('openclaw-session-1');

    await mocks.getKillHandler()!();
    await settled;
  });
});
