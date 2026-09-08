import { describe, expect, it, vi } from 'vitest';
import { StandardCopilotBackend } from './StandardCopilotBackend';

describe('StandardCopilotBackend', () => {
  it('can return a reply without emitting raw model output for local document execution', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'conversation-1' }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({
        id: 'conversation-1',
        turnCount: 1,
        messages: [{ text: '문서 요청' }, { text: '{"format":"docx"}' }],
      }));
    const backend = new StandardCopilotBackend({
      tokenProvider: { getAccessToken: vi.fn().mockResolvedValue('ACCESS_TOKEN') },
      fetchImpl,
    });
    const messages: unknown[] = [];
    backend.onMessage((message) => messages.push(message));
    const { sessionId } = await backend.startSession();

    await expect(backend.generateText(sessionId, '문서 요청'))
      .resolves.toBe('{"format":"docx"}');
    expect(messages).toEqual([
      { type: 'status', status: 'running' },
      { type: 'status', status: 'idle' },
    ]);
  });

  it('creates one Work IQ conversation and reuses it across Happy turns', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'conversation-1' }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({
        id: 'conversation-1',
        turnCount: 1,
        messages: [{ text: '첫 질문' }, { text: '첫 답변' }],
      }))
      .mockResolvedValueOnce(Response.json({
        id: 'conversation-1',
        turnCount: 2,
        messages: [
          { text: '첫 질문' },
          { text: '첫 답변' },
          { text: '둘째 질문' },
          { text: '둘째 답변' },
        ],
      }));
    const backend = new StandardCopilotBackend({
      tokenProvider: { getAccessToken: vi.fn().mockResolvedValue('ACCESS_TOKEN') },
      fetchImpl,
    });
    const messages: unknown[] = [];
    backend.onMessage((message) => messages.push(message));

    await expect(backend.startSession()).resolves.toEqual({ sessionId: 'conversation-1' });
    await backend.sendPrompt('conversation-1', '첫 질문');
    await backend.sendPrompt('conversation-1', '둘째 질문');

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'https://workiq.svc.cloud.microsoft/rest/conversations',
      'https://workiq.svc.cloud.microsoft/rest/conversations/conversation-1/chat',
      'https://workiq.svc.cloud.microsoft/rest/conversations/conversation-1/chat',
    ]);
    expect(messages).toEqual([
      { type: 'status', status: 'running' },
      { type: 'model-output', textDelta: '첫 답변' },
      { type: 'status', status: 'idle' },
      { type: 'status', status: 'running' },
      { type: 'model-output', textDelta: '둘째 답변' },
      { type: 'status', status: 'idle' },
    ]);
  });

  it('reports request counts, status, and duration without estimating credits or exposing tokens', async () => {
    const onRequest = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'conversation-1' }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({
        id: 'conversation-1',
        turnCount: 1,
        messages: [{ text: '질문' }, { text: '답변' }],
      }));
    const backend = new StandardCopilotBackend({
      tokenProvider: { getAccessToken: vi.fn().mockResolvedValue('SECRET_TOKEN') },
      fetchImpl,
      onRequest,
    });

    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, '질문');

    expect(onRequest.mock.calls.map(([event]) => [event.operation, event.state])).toEqual([
      ['create', 'started'],
      ['create', 'succeeded'],
      ['chat', 'started'],
      ['chat', 'succeeded'],
    ]);
    expect(onRequest.mock.calls[3][0]).toMatchObject({ httpStatus: 200, durationMs: expect.any(Number) });
    expect(JSON.stringify(onRequest.mock.calls)).not.toContain('SECRET_TOKEN');
    expect(JSON.stringify(onRequest.mock.calls)).not.toContain('credits');
  });

  it('rejects blank prompts before a chat request', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'conversation-1' }, { status: 201 }));
    const backend = new StandardCopilotBackend({
      tokenProvider: { getAccessToken: vi.fn().mockResolvedValue('ACCESS_TOKEN') },
      fetchImpl,
    });
    const { sessionId } = await backend.startSession();

    await expect(backend.sendPrompt(sessionId, ' ')).rejects.toThrow('1~30,000자');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sanitizes HTTP and network failures without leaking response bodies or tokens', async () => {
    const tokenProvider = { getAccessToken: vi.fn().mockResolvedValue('SECRET_TOKEN') };
    const deniedFetch = vi.fn<typeof fetch>()
      .mockResolvedValue(new Response('SECRET_BODY', { status: 403 }));
    const denied = new StandardCopilotBackend({ tokenProvider, fetchImpl: deniedFetch });
    await expect(denied.startSession()).rejects.toThrow('HTTP 403');
    await expect(denied.startSession()).rejects.not.toThrow('SECRET_BODY');

    const network = new StandardCopilotBackend({
      tokenProvider,
      fetchImpl: vi.fn().mockRejectedValue(new Error('Bearer SECRET_TOKEN')),
    });
    await expect(network.startSession()).rejects.toThrow('네트워크 요청 실패');
    await expect(network.startSession()).rejects.not.toThrow('SECRET_TOKEN');
  });

  it('rejects mismatched or empty replies instead of emitting a successful turn', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'conversation-1' }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({
        id: 'other-conversation',
        turnCount: 1,
        messages: [{ text: '질문' }, { text: '답변' }],
      }));
    const backend = new StandardCopilotBackend({
      tokenProvider: { getAccessToken: vi.fn().mockResolvedValue('ACCESS_TOKEN') },
      fetchImpl,
    });
    const messages: unknown[] = [];
    backend.onMessage((message) => messages.push(message));
    const { sessionId } = await backend.startSession();

    await expect(backend.sendPrompt(sessionId, '질문')).rejects.toThrow('응답 형식');
    expect(messages).toEqual([
      { type: 'status', status: 'running' },
      { type: 'status', status: 'idle' },
    ]);
  });
});
