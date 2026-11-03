import { afterEach, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { runReservationNativeProvider } from './reservationNativeProvider';
const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
const nativeId = '12345678-1234-4234-8234-123456789abc';
const input = (agent: 'claude' | 'codex') => ({ agent, nativeId, prompt: 'scheduled question', cwd: '/worktree', uid: 65534, gid: 65534,
  environmentFile: '/private/env', mcpConfig: '/home/agent/mcp.json', signal: new AbortController().signal, output: vi.fn(async () => {}) });
function runtime(source: string) {
  return { execute: vi.fn(async () => { const child = spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child); return child; }) };
}
it('resumes Claude with an explicit native ID and consumes its authoritative completed answer', async () => {
  const r = runtime(`const rl=require('readline').createInterface({input:process.stdin});
    console.log(JSON.stringify({type:'system',subtype:'init',session_id:'${nativeId}'}));
    rl.on('line',line=>{const v=JSON.parse(line);if(v.message.content!=='scheduled question')process.exit(4);
    console.log(JSON.stringify({type:'assistant',session_id:'${nativeId}',message:{content:[{type:'text',text:'안녕하세요'}]}}));
    console.log(JSON.stringify({type:'result',subtype:'success',session_id:'${nativeId}',result:'안녕하세요'}));});`);
  const value = input('claude');
  expect(await runReservationNativeProvider(r, {} as never, value)).toEqual({ outcome: 'WOKE' });
  expect(r.execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ command: 'claude', args: expect.arrayContaining(['--resume', nativeId, '--tools', '']) }));
  expect(value.output).toHaveBeenCalledWith(expect.objectContaining({ raw: expect.objectContaining({ type: 'result' }) }));
});
it('uses only Codex initialize, thread/resume and turn/start and refuses approvals or a fork fallback', async () => {
  const methods: string[] = [];
  const r = runtime(`require('readline').createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);
    if(v.method==='initialized')return;
    if(!['initialize','thread/resume','turn/start'].includes(v.method))process.exit(9);
    if(v.method==='thread/resume'&&v.params.threadId!=='${nativeId}')process.exit(10);
    const result=v.method==='thread/resume'?{thread:{id:'${nativeId}'}}:v.method==='turn/start'?{turn:{id:'turn'}}:{};
    console.log(JSON.stringify({jsonrpc:'2.0',id:v.id,result}));
    if(v.method==='turn/start'){
      console.log(JSON.stringify({method:'item/completed',params:{threadId:'${nativeId}',item:{type:'agentMessage',phase:'final_answer',text:'[SILENT]'}}}));
      console.log(JSON.stringify({method:'turn/completed',params:{threadId:'${nativeId}',turn:{id:'turn',status:'completed'}}}));}});`);
  expect(await runReservationNativeProvider(r, {} as never, input('codex'))).toEqual({ outcome: 'SILENT' });
  expect(r.execute).toHaveBeenCalledOnce();
});
it('refuses another native conversation and does not emit any output from it', async () => {
  const r = runtime(`console.log(JSON.stringify({type:'system',subtype:'init',session_id:'foreign'}));process.stdin.resume();`);
  const value = input('claude');
  await expect(runReservationNativeProvider(r, {} as never, value)).rejects.toThrow('RESERVATION_NATIVE_PROTOCOL_INVALID');
  expect(value.output).not.toHaveBeenCalled();
});
it('stops accepting output immediately when the epoch is revoked and leaves whole-container termination to its owner', async () => {
  const r = runtime(`process.stdin.resume();`), controller = new AbortController();
  const value = { ...input('codex'), signal: controller.signal };
  const turn = runReservationNativeProvider(r, {} as never, value);
  await vi.waitFor(() => expect(r.execute).toHaveBeenCalledOnce()); controller.abort();
  await expect(turn).rejects.toThrow('RESERVATION_AUTHORITY_LOST'); expect(value.output).not.toHaveBeenCalled();
});
