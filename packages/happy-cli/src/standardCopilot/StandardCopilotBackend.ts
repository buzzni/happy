/**
 * AgentBackend adapter for Microsoft Work IQ REST conversations.
 */
import { z } from 'zod';
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
} from '@/agent/core/AgentBackend';
import type { StandardCopilotTokenProvider } from './auth';

const WORK_IQ_REST_URL = 'https://workiq.svc.cloud.microsoft/rest/conversations';
const conversationSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
});
const replySchema = conversationSchema.extend({
  turnCount: z.number().int().positive(),
  messages: z.array(z.object({ text: z.string() })).min(2),
});

export type StandardCopilotBackendOptions = {
  tokenProvider: StandardCopilotTokenProvider;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onRequest?: (event: StandardCopilotRequestEvent) => void;
};

export type StandardCopilotRequestEvent = {
  operation: 'create' | 'chat';
  state: 'started' | 'succeeded' | 'failed';
  at: string;
  httpStatus?: number;
  durationMs?: number;
};

export class StandardCopilotBackendError extends Error {}

export class StandardCopilotBackend implements AgentBackend {
  private readonly tokenProvider: StandardCopilotTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly onRequest?: (event: StandardCopilotRequestEvent) => void;
  private readonly handlers = new Set<AgentMessageHandler>();
  private conversationId: string | null = null;
  private activeRequest: AbortController | null = null;

  constructor(options: StandardCopilotBackendOptions) {
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.onRequest = options.onRequest;
  }

  async startSession(): Promise<StartSessionResult> {
    if (this.conversationId) {
      return { sessionId: this.conversationId };
    }
    const created = conversationSchema.safeParse(await this.post({
      operation: 'create',
      url: WORK_IQ_REST_URL,
      body: {},
      expectedStatus: 201,
    }));
    if (!created.success) {
      throw new StandardCopilotBackendError('Work IQ 응답 형식이 올바르지 않습니다.');
    }
    this.conversationId = created.data.id;
    return { sessionId: created.data.id };
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    this.emit({ type: 'status', status: 'running' });
    try {
      const text = await this.requestText(sessionId, prompt);
      this.emit({ type: 'model-output', textDelta: text });
    } finally {
      this.emit({ type: 'status', status: 'idle' });
    }
  }

  async generateText(sessionId: SessionId, prompt: string): Promise<string> {
    this.emit({ type: 'status', status: 'running' });
    try {
      return await this.requestText(sessionId, prompt);
    } finally {
      this.emit({ type: 'status', status: 'idle' });
    }
  }

  private async requestText(sessionId: SessionId, prompt: string): Promise<string> {
    if (!prompt.trim() || prompt.length > 30_000) {
      throw new StandardCopilotBackendError('프롬프트는 1~30,000자여야 합니다.');
    }
    if (!this.conversationId || sessionId !== this.conversationId) {
      throw new StandardCopilotBackendError('Work IQ 대화 세션이 일치하지 않습니다.');
    }

    const result = replySchema.safeParse(await this.post({
      operation: 'chat',
      url: `${WORK_IQ_REST_URL}/${encodeURIComponent(sessionId)}/chat`,
      expectedStatus: 200,
      body: {
        message: { text: prompt },
        locationHint: { timeZone: 'Asia/Seoul' },
        contextualResources: { webContext: { isWebEnabled: false } },
      },
    }));
    const text = result.success ? result.data.messages.at(-1)?.text.trim() : undefined;
    if (!result.success || result.data.id !== sessionId || !text || text === prompt) {
      throw new StandardCopilotBackendError('Work IQ 응답 형식이 올바르지 않습니다.');
    }
    return text;
  }

  async cancel(_sessionId: SessionId): Promise<void> {
    this.activeRequest?.abort();
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.add(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers.delete(handler);
  }

  async dispose(): Promise<void> {
    this.activeRequest?.abort();
    this.activeRequest = null;
    this.handlers.clear();
  }

  private emit(message: AgentMessage): void {
    for (const handler of this.handlers) handler(message);
  }

  private async post(input: {
    operation: 'create' | 'chat';
    url: string;
    body: unknown;
    expectedStatus: number;
  }): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    this.activeRequest = controller;
    const started = Date.now();
    this.onRequest?.({ operation: input.operation, state: 'started', at: new Date(started).toISOString() });
    let httpStatus: number | undefined;
    try {
      const accessToken = await this.tokenProvider.getAccessToken();
      const response = await this.fetchImpl(input.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input.body),
        redirect: 'error',
        signal: controller.signal,
      });
      httpStatus = response.status;
      if (response.status !== input.expectedStatus) {
        throw new StandardCopilotBackendError(`Work IQ 요청 실패 (HTTP ${response.status}).`);
      }
      try {
        const body = await response.json();
        this.onRequest?.({
          operation: input.operation,
          state: 'succeeded',
          at: new Date().toISOString(),
          httpStatus,
          durationMs: Date.now() - started,
        });
        return body;
      } catch {
        throw new StandardCopilotBackendError('Work IQ 응답 형식이 올바르지 않습니다.');
      }
    } catch (error) {
      this.onRequest?.({
        operation: input.operation,
        state: 'failed',
        at: new Date().toISOString(),
        httpStatus,
        durationMs: Date.now() - started,
      });
      if (error instanceof StandardCopilotBackendError) throw error;
      throw new StandardCopilotBackendError('Work IQ 네트워크 요청 실패 또는 시간 초과입니다.');
    } finally {
      clearTimeout(timeout);
      if (this.activeRequest === controller) this.activeRequest = null;
    }
  }
}
