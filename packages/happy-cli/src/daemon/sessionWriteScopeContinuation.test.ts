import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { createSessionWriteScopeContinuation } from './sessionWriteScopeContinuation';
import type { ScopeRequest } from './sessionWriteScope';
import type { TrackedSession } from './types';
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
function fixture() {
  let clock = 1000;
  const request = { id: 'request', sessionId: 'session', kind: 'grant', state: 'cleanup-unresolved',
    profileApplied: true, grantActive: true } as ScopeRequest;
  const session: TrackedSession = { startedBy: 'daemon', happySessionId: 'session', pid: 123,
    childProcess: { exitCode: null, signalCode: null } as TrackedSession['childProcess'],
    encryption: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey', seq: 10, metadataVersion: 0, agentStateVersion: 0 },
    runtime: { thinking: false, hasOpenToolCall: false, lastProcessedSeq: 5, updatedAt: 1 } };
  const requests = [request];
  vi.mocked(axios.get).mockReset().mockResolvedValue({ data: { messages: [], hasMore: false } });
  vi.mocked(axios.post).mockReset().mockImplementation(async (_url, body: any) => ({ data: { messages: [{ ...body.messages[0], id: 'stored', seq: 11 }] } }));
  const readToken = vi.fn(async (): Promise<string | null> => 'fixture');
  const continuation = createSessionWriteScopeContinuation({ serverUrl: 'http://localhost', now: () => clock,
    findSession: () => session, list: () => requests, readToken, log: vi.fn() });
  return { request, session, requests, continuation, readToken, advance: () => { clock += 2000; } };
}
describe('scope continuation encrypted delivery', () => {
  it('wakes a successfully applied live session once without an extra user send', async () => {
    const f = fixture(); f.continuation.capture(f.request); f.continuation.applied(f.request);
    await Promise.all([f.continuation.flush(), f.continuation.flush()]); await f.continuation.flush();
    expect(axios.post).toHaveBeenCalledOnce();
    const body = vi.mocked(axios.post).mock.calls[0][1] as any;
    expect(body.messages[0].localId).toBe('write-scope-applied-request');
    const decoded = decrypt(f.session.encryption!.encryptionKey, 'dataKey', decodeBase64(body.messages[0].content)) as any;
    expect(decoded.meta).toEqual({ sentFrom: 'daemon', source: 'session-write-scope' });
    expect(decoded.content.text).toContain('session_write_scope');
    expect(decoded.content.text).not.toContain('/target');
  });
  it.each(['user', 'malformed', 'revoked', 'ended', 'busy', 'closed'] as const)('does not send with %s evidence', async kind => {
    const f = fixture(); f.continuation.capture(f.request); f.continuation.applied(f.request);
    if (kind === 'user') {
      const content = encodeBase64(encrypt(f.session.encryption!.encryptionKey, 'dataKey', { role: 'user', content: { type: 'text', text: 'new instruction' } }));
      vi.mocked(axios.get).mockResolvedValue({ data: { messages: [{ seq: 6, content: { t: 'encrypted', c: content } }], hasMore: false } });
    }
    if (kind === 'malformed') vi.mocked(axios.get).mockResolvedValue({ data: {} });
    if (kind === 'revoked') f.request.grantActive = false;
    if (kind === 'ended') Object.defineProperty(f.session.childProcess!, 'exitCode', { value: 0 });
    if (kind === 'busy') f.session.runtime!.thinking = true;
    if (kind === 'closed') f.continuation.close();
    await f.continuation.flush(); expect(axios.post).not.toHaveBeenCalled();
  });
  it('waits for applying requests and coalesces success, without immediate replay after an ambiguous POST', async () => {
    const f = fixture(); f.continuation.capture(f.request); f.continuation.applied(f.request);
    const other: ScopeRequest = { ...f.request, id: 'other', state: 'applying' }; f.requests.push(other);
    await f.continuation.flush(); expect(axios.post).not.toHaveBeenCalled();
    f.continuation.capture(other); other.state = 'cleanup-unresolved'; f.continuation.applied(other);
    vi.mocked(axios.post).mockRejectedValue(new Error('timeout'));
    await f.continuation.flush(); await f.continuation.flush(); expect(axios.post).toHaveBeenCalledOnce();
  });
  it('rechecks revocation after asynchronous history reading', async () => {
    const f = fixture(); f.continuation.capture(f.request); f.continuation.applied(f.request);
    vi.mocked(axios.get).mockImplementation(async () => { f.request.grantActive = false; return { data: { messages: [], hasMore: false } }; });
    await f.continuation.flush(); expect(axios.post).not.toHaveBeenCalled();
  });
});

it('retains the input baseline through waiting polls and never restores it in a new instance', async () => {
  const f = fixture(); f.request.state = 'pending'; f.continuation.capture(f.request);
  await f.continuation.flush(); await f.continuation.flush();
  f.request.state = 'cleanup-unresolved'; f.continuation.applied(f.request);
  await f.continuation.flush(); expect(axios.post).toHaveBeenCalledOnce();
  f.continuation.close();
  const g = fixture(); g.continuation.applied(g.request);
  await g.continuation.flush(); expect(axios.post).not.toHaveBeenCalled();
});

it('posts an encrypted wake-up over real local HTTP and accepts its matching acknowledgement', async () => {
  const { createServer } = await import('node:http');
  const actual = (await vi.importActual<typeof import('axios')>('axios')).default;
  const f = fixture(); let received: any;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET') { response.end(JSON.stringify({ messages: [], hasMore: false })); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString());
    response.end(JSON.stringify({ messages: [{ ...received.messages[0], id: 'stored', seq: 12 }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const c = createSessionWriteScopeContinuation({
    serverUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,
    findSession: () => f.session, list: () => f.requests, readToken: async () => 'test-only', log: vi.fn(),
  });
  vi.mocked(axios.get).mockImplementation(actual.get); vi.mocked(axios.post).mockImplementation(actual.post);
  try {
    c.capture(f.request); c.applied(f.request); await c.flush();
    expect(received.messages[0].localId).toBe('write-scope-applied-request');
    expect(JSON.stringify(received)).not.toContain('folder access was applied');
    const decoded = decrypt(f.session.encryption!.encryptionKey, 'dataKey', decodeBase64(received.messages[0].content)) as any;
    expect(decoded.content.text).toContain('previously authorized task');
  } finally { c.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

it.each(['hasMore', 'key', 'pid', 'lookupFailure'] as const)('suppresses a wake-up for %s uncertainty', async kind => {
  const f = fixture(); f.continuation.capture(f.request); f.continuation.applied(f.request);
  if (kind === 'hasMore') vi.mocked(axios.get).mockResolvedValue({ data: { messages: [], hasMore: true } });
  if (kind === 'key') f.session.encryption!.encryptionKey = new Uint8Array(32).fill(2);
  if (kind === 'pid') f.session.pid += 1;
  if (kind === 'lookupFailure') vi.mocked(axios.get).mockRejectedValue(new Error('offline'));
  await f.continuation.flush(); expect(axios.post).not.toHaveBeenCalled();
});

it('ignores real session-protocol turn/tool history and the consumed user projection', async () => {
  const { createEnvelope } = await import('@slopus/happy-wire');
  const f = fixture(); f.continuation.capture(f.request); f.continuation.applied(f.request);
  const values = [
    { role: 'session', content: createEnvelope('user', { t: 'text', text: 'original consumed task' }), meta: { sentFrom: 'cli' } },
    { role: 'session', content: createEnvelope('agent', { t: 'turn-start' }) },
    { role: 'session', content: createEnvelope('agent', { t: 'text', text: 'Waiting for folder approval' }) },
    { role: 'session', content: createEnvelope('agent', { t: 'turn-end', status: 'completed' }) },
    // ApiSessionClient.sendSessionEvent and sendCodexMessage also publish legacy agent rows.
    { role: 'agent', content: { id: 'ready-event', type: 'event', data: { type: 'ready' } } },
    { role: 'agent', content: { id: 'notice-event', type: 'event', data: { type: 'message', message: 'Codex resumed' } } },
    { role: 'agent', content: { type: 'codex', data: { type: 'message' } } },
  ];
  vi.mocked(axios.get).mockResolvedValue({ data: { hasMore: false, messages: values.map((value, i) => ({ seq: 6+i, content: {
    t: 'encrypted', c: encodeBase64(encrypt(f.session.encryption!.encryptionKey, 'dataKey', value)),
  } })) } });
  await f.continuation.flush(); expect(axios.post).toHaveBeenCalledOnce();
});

it('treats an app attachment envelope as new input, including without a text message', async () => {
  const f = fixture(); f.continuation.capture(f.request); f.continuation.applied(f.request);
  const value = { role: 'session', content: { type: 'session', data: { id: 'file', time: 1, role: 'user', ev: {
    t: 'file', ref: 'encrypted-blob', name: 'new.png', size: 2,
  } } } };
  vi.mocked(axios.get).mockResolvedValue({ data: { hasMore: false, messages: [{ seq: 6, content: {
    t: 'encrypted', c: encodeBase64(encrypt(f.session.encryption!.encryptionKey, 'dataKey', value)),
  } }] } });
  await f.continuation.flush(); expect(axios.post).not.toHaveBeenCalled();
});

it('waits for the replacement first runtime report and temporary token/history failures', async () => {
  const f = fixture(), runtime = f.session.runtime;
  f.continuation.capture(f.request); f.continuation.applied(f.request); delete f.session.runtime;
  await f.continuation.flush(); expect(axios.post).not.toHaveBeenCalled();
  f.session.runtime = runtime; vi.mocked(axios.get).mockRejectedValueOnce(new Error('offline'));
  await f.continuation.flush(); f.advance(); await f.continuation.flush();
  expect(axios.post).toHaveBeenCalledOnce();
});

it('retries only the identical encrypted message and stops when history confirms a lost acknowledgement', async () => {
  const f = fixture(); f.continuation.capture(f.request); f.continuation.applied(f.request);
  vi.mocked(axios.post).mockRejectedValue(new Error('timeout'));
  await f.continuation.flush(); f.advance(); await f.continuation.flush();
  expect(axios.post).toHaveBeenCalledTimes(2);
  expect(vi.mocked(axios.post).mock.calls[1][1]).toEqual(vi.mocked(axios.post).mock.calls[0][1]);
  const body = vi.mocked(axios.post).mock.calls[0][1] as any;
  vi.mocked(axios.get).mockResolvedValue({ data: { hasMore: false, messages: [{ seq: 6, localId: body.messages[0].localId,
    content: { t: 'encrypted', c: body.messages[0].content } }] } });
  f.advance(); await f.continuation.flush(); f.advance(); await f.continuation.flush();
  expect(axios.post).toHaveBeenCalledTimes(2);
});

it('reads through transcript pages and does not block on an unapproved request', async () => {
  const { createEnvelope } = await import('@slopus/happy-wire');
  const f = fixture(); f.continuation.capture(f.request); f.continuation.applied(f.request);
  f.requests.push({ ...f.request, id: 'unapproved', state: 'pending', grantActive: false });
  const c = encodeBase64(encrypt(f.session.encryption!.encryptionKey, 'dataKey', { role: 'session',
    content: createEnvelope('agent', { t: 'turn-end', status: 'completed' }) }));
  vi.mocked(axios.get).mockResolvedValueOnce({ data: { messages: [{ seq: 6, content: { t: 'encrypted', c } }], hasMore: true } })
    .mockResolvedValueOnce({ data: { messages: [], hasMore: false } });
  await f.continuation.flush(); expect(axios.get).toHaveBeenCalledTimes(2); expect(axios.post).toHaveBeenCalledOnce();
});

it('retains an earlier active grant when the most recent batched grant is revoked', async () => {
  const f = fixture(); f.continuation.capture(f.request); f.continuation.applied(f.request);
  const second = { ...f.request, id: 'second' }; f.requests.push(second);
  f.continuation.capture(second); f.continuation.applied(second); second.grantActive = false;
  await f.continuation.flush(); expect(axios.post).toHaveBeenCalledOnce();
  expect((vi.mocked(axios.post).mock.calls[0][1] as any).messages[0].localId).toBe('write-scope-applied-request');
});

it('bounds same-message POST retries at three and waits for a temporarily unavailable token', async () => {
  const f = fixture(); f.continuation.capture(f.request); f.continuation.applied(f.request);
  f.readToken.mockResolvedValueOnce(null); await f.continuation.flush(); expect(axios.post).not.toHaveBeenCalled();
  vi.mocked(axios.post).mockRejectedValue(new Error('timeout'));
  for (let i = 0; i < 6; i++) { f.advance(); await f.continuation.flush(); }
  expect(axios.post).toHaveBeenCalledTimes(3);
});
