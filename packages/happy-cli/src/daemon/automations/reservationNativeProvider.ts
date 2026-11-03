import { StringDecoder } from 'node:string_decoder';
import { isSilentAutomationResponse } from './automationDomain';
import type { ChildProcess } from 'node:child_process';
import type { ReservationContainer, ReservationNativeContainers } from './reservationNativeContainer';

type ProviderInput = { agent: 'claude' | 'codex'; nativeId: string; prompt: string; model?: string | null; effort?: string | null;
  cwd: string; uid: number; gid: number; environmentFile: string; mcpConfig: string; signal: AbortSignal;
  /** The trusted host stores output in the existing Happy session; providers hold no Happy bearer. */
  output(event: { provider: 'claude' | 'codex'; raw: unknown; text?: string; final?: boolean }): Promise<void>;
};
function assertNativeId(actual: unknown, expected: string) {
  if (actual !== expected) throw new Error('RESERVATION_NATIVE_LINEAGE_MISMATCH');
}

/** Starts only an explicit resume. No Happy session creation, provider start-thread or fork request exists here. */
export async function runReservationNativeProvider(runtime: Pick<ReservationNativeContainers, 'execute'>, handle: ReservationContainer, input: ProviderInput): Promise<{ outcome: 'WOKE' | 'SILENT' }> {
  if (!/^[a-f0-9-]{36}$/i.test(input.nativeId) || !input.prompt.trim()) throw new Error('RESERVATION_NATIVE_INPUT_INVALID');
  input.signal.throwIfAborted();
  const args = input.agent === 'claude'
    ? ['--print', '--resume', input.nativeId, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--strict-mcp-config', '--mcp-config', input.mcpConfig, '--setting-sources', '', '--tools', '',
      '--permission-mode', 'bypassPermissions', ...(input.model ? ['--model', input.model] : []), ...(input.effort && input.effort !== 'none' ? ['--effort', input.effort] : [])]
    : ['app-server', '--listen', 'stdio://', '--disable', 'multi_agent', '--disable', 'multi_agent_v2', '--disable', 'hooks', '--disable', 'plugins'];
  const child = await runtime.execute(handle, { command: input.agent, args, cwd: input.cwd, uid: input.uid, gid: input.gid, environmentFile: input.environmentFile });
  return input.agent === 'claude' ? runClaude(child, input) : runCodex(child, input);
}

type Lines = { send(value: unknown): void; close(): void };
function lines(child: ChildProcess, input: ProviderInput, receive: (value: any) => void, fail: (error: Error) => void, exited: (code: number | null) => void): Lines {
  let buffer = '', closed = false; const decoder = new StringDecoder('utf8');
  const error = () => fail(new Error('RESERVATION_NATIVE_PROCESS_FAILED'));
  const data = (chunk: Buffer) => {
    if (closed || input.signal.aborted) return;
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { fail(new Error('RESERVATION_NATIVE_OUTPUT_LIMIT')); return; }
    let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { receive(JSON.parse(line)); } catch { fail(new Error('RESERVATION_NATIVE_PROTOCOL_INVALID')); return; }
    }
  };
  const exit = (code: number | null) => exited(code);
  child.stdout!.on('data', data); child.once('error', error); child.once('close', exit);
  child.stderr!.resume(); child.stdin!.on('error', error);
  return {
    send(value) { if (closed || input.signal.aborted) throw new Error('RESERVATION_AUTHORITY_EXPIRED'); child.stdin!.write(JSON.stringify(value) + '\n'); },
    close() { closed = true; child.stdout!.off('data', data); child.off('error', error); child.off('close', exit); child.stdin!.off('error', error); child.stdin!.on('error', () => {}); },
  };
}
const outcome = (text: string) => ({ outcome: isSilentAutomationResponse(text) ? 'SILENT' as const : 'WOKE' as const });

async function runClaude(child: ChildProcess, input: ProviderInput): Promise<{ outcome: 'WOKE' | 'SILENT' }> {
  return new Promise((resolve, reject) => {
    let initialized = false, completed = false, text = '', writes = Promise.resolve(), settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; channel.close(); input.signal.removeEventListener('abort', abort);
      if (error) reject(error); else writes.then(() => resolve(outcome(text)), () => reject(new Error('RESERVATION_OUTPUT_UNCONFIRMED')));
    };
    const abort = () => finish(new Error('RESERVATION_AUTHORITY_LOST'));
    const channel = lines(child, input, value => {
      if (value.type === 'system' && value.subtype === 'init') { assertNativeId(value.session_id, input.nativeId); initialized = true; }
      if (!initialized) throw new Error();
      if (value.session_id !== undefined) assertNativeId(value.session_id, input.nativeId);
      if (value.type === 'result') {
        if (value.is_error || value.subtype !== 'success') { finish(new Error('RESERVATION_NATIVE_TURN_FAILED')); return; }
        text = typeof value.result === 'string' ? value.result : text; completed = true;
      }
      const body = value.type === 'assistant' ? value.message?.content : null;
      if (Array.isArray(body)) text = body.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n') || text;
      writes = writes.then(() => input.output({ provider: 'claude', raw: value }));
      // Attach a rejection observer immediately; final settlement still requires all writes.
      void writes.catch(() => finish(new Error('RESERVATION_OUTPUT_UNCONFIRMED')));
    }, finish, code => finish(code === 0 && completed ? undefined : new Error('RESERVATION_NATIVE_EXIT_UNCONFIRMED')));
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) { abort(); return; }
    channel.send({ type: 'user', session_id: input.nativeId, message: { role: 'user', content: input.prompt }, parent_tool_use_id: null });
    child.stdin!.end();
  });
}

async function runCodex(child: ChildProcess, input: ProviderInput): Promise<{ outcome: 'WOKE' | 'SILENT' }> {
  return new Promise((resolve, reject) => {
    let sequence = 0, text = '', acceptedTurn: string | null = null, earlyCompletion: any = null, writes = Promise.resolve(), settled = false;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    const finish = (error?: Error) => {
      if (settled) return; settled = true; channel.close(); input.signal.removeEventListener('abort', abort);
      for (const timer of timers.values()) clearTimeout(timer);
      for (const request of pending.values()) request.reject(new Error('RESERVATION_NATIVE_CHANNEL_CLOSED'));
      pending.clear();
      if (error) reject(error); else writes.then(async () => {
        const ended = new Promise<void>(done => { const timer = setTimeout(done, 5000); child.once('close', () => { clearTimeout(timer); done(); }); });
        child.stdin!.end(); await ended; resolve(outcome(text));
      }, () => reject(new Error('RESERVATION_OUTPUT_UNCONFIRMED')));
    };
    const abort = () => finish(new Error('RESERVATION_AUTHORITY_LOST'));
    const completion = (params: any) => {
      if (!acceptedTurn) { earlyCompletion = params; return; }
      if (params.threadId !== input.nativeId || params.turn?.id !== acceptedTurn) return;
      finish(params.turn.status === 'completed' ? undefined : new Error('RESERVATION_NATIVE_TURN_FAILED'));
    };
    const channel = lines(child, input, value => {
      if (typeof value.id === 'number' && !value.method) {
        const request = pending.get(value.id); if (!request) return;
        pending.delete(value.id); clearTimeout(timers.get(value.id)); timers.delete(value.id);
        if (value.error) request.reject(new Error('RESERVATION_NATIVE_REQUEST_REJECTED')); else request.resolve(value.result);
        return;
      }
      // No interactive approval or sub-agent request may widen this descriptor.
      if (value.method && value.id !== undefined) { channel.send({ jsonrpc: '2.0', id: value.id, error: { code: -32000, message: 'Reservation scope cannot be expanded' } }); return; }
      const params = value.params;
      if (params?.threadId && params.threadId !== input.nativeId) throw new Error();
      if (value.method === 'item/completed' && params?.item?.type === 'agentMessage') {
        const final = params.item.phase === 'final_answer';
        if (final) text = params.item.text ?? text;
        writes = writes.then(() => input.output({ provider: 'codex', raw: value, text: params.item.text, final }));
        void writes.catch(() => finish(new Error('RESERVATION_OUTPUT_UNCONFIRMED')));
      }
      if (value.method === 'turn/completed') completion(params);
    }, finish, () => finish(new Error('RESERVATION_NATIVE_EXIT_UNCONFIRMED')));
    const request = (method: string, params: unknown): Promise<any> => new Promise((resolveRequest, rejectRequest) => {
      if (settled) { rejectRequest(new Error('RESERVATION_NATIVE_CHANNEL_CLOSED')); return; }
      const id = ++sequence; pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      timers.set(id, setTimeout(() => { pending.delete(id); timers.delete(id); rejectRequest(new Error('RESERVATION_NATIVE_RPC_TIMEOUT')); }, 30000));
      channel.send({ jsonrpc: '2.0', id, method, params });
    });
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) { abort(); return; }
    void (async () => {
      await request('initialize', { clientInfo: { name: 'saycode-reservation', version: '1' }, capabilities: { experimentalApi: true } });
      channel.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
      const resumed = await request('thread/resume', { threadId: input.nativeId, cwd: input.cwd, model: input.model ?? null,
        approvalPolicy: 'never', sandbox: 'danger-full-access', modelProvider: 'reservation', persistExtendedHistory: true,
        config: { 'mcp_servers': { saycode: { command: 'node', args: [input.mcpConfig] } }, 'features.multi_agent': false, 'features.multi_agent_v2': false } });
      assertNativeId(resumed.thread?.id, input.nativeId);
      const started = await request('turn/start', { threadId: input.nativeId, cwd: input.cwd, model: input.model ?? undefined,
        effort: input.effort ?? undefined, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, input: [{ type: 'text', text: input.prompt }] });
      if (typeof started.turn?.id !== 'string' || !started.turn.id) throw new Error('RESERVATION_NATIVE_PROTOCOL_INVALID');
      acceptedTurn = started.turn.id; if (earlyCompletion) completion(earlyCompletion);
    })().catch(() => finish(new Error('RESERVATION_NATIVE_RESUME_FAILED')));
  });
}
