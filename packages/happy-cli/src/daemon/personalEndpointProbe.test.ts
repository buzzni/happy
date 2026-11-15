import { expect, it } from 'vitest'
import { endpointProbeFailure, validateEndpointProbeResult } from './personalEndpointProbe'
it('requires real streaming, a completed tool call and successful SDK completion', () => {
  expect(validateEndpointProbeResult('{"version":1,"ok":true,"streaming":true,"toolCall":true}')).toBe(true)
  expect(endpointProbeFailure('{"error":"PERSONAL_ENDPOINT_AUTHENTICATION_FAILED"}')).toBe('PERSONAL_ENDPOINT_AUTHENTICATION_FAILED')
  expect(endpointProbeFailure('{"error":"provider echoed fixture-secret"}')).toBe('PERSONAL_ENDPOINT_COMPATIBILITY_FAILED')
  for (const result of ['{}', '{"ok":true}', '{"version":1,"ok":true,"streaming":true,"toolCall":false}', 'HTML']) expect(validateEndpointProbeResult(result)).toBe(false)
})

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectPath } from '@/projectPath';
import { buildPersonalEndpointEnvironment } from './personalLlmEndpoint';

it.skipIf(process.env.HAPPY_PERSONAL_ENDPOINT_SDK_INTEGRATION !== '1').each(['success', 'auth', 'no-tool'] as const)('runs the real SDK probe without leaking provider failures (%s)', async scenario => {
const dir=await mkdtemp(join(tmpdir(),'llm-real-sdk-')), requests: Array<{ auth?: string; model: string; tools?: string[]; stream?: boolean }>=[];
let toolUsed=false;
const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  if(!req.url?.startsWith('/inference/probe/v1/messages')){res.writeHead(404);res.end('{}');return;}
  if (scenario === 'auth') { res.writeHead(401, {'content-type':'application/json'}); res.end(JSON.stringify({type:'error',error:{type:'authentication_error',message:'fixture-private-token must not escape'}})); return; }
  const body=JSON.parse(raw); requests.push({auth:req.headers.authorization,model:body.model,tools:body.tools?.map((t: {name:string})=>t.name),stream:body.stream});
  const tools=body.tools??[], tool=tools.find((t: {name:string})=>t.name==='mcp__endpoint-probe__echo');
  const sawResult=body.messages?.some((m: {content: Array<{type:string}>})=>Array.isArray(m.content)&&m.content.some(c=>c.type==='tool_result'));
  const call=scenario !== 'no-tool'&&!!tool&&!sawResult; if(call)toolUsed=true;
  const content=call?{type:'tool_use',id:'toolu_fixture',name:tool.name,input:{}}:{type:'text',text:'OK'};
  const reason=call?'tool_use':'end_turn';
  const result={id:'msg_fixture_'+requests.length,type:'message',role:'assistant',model:body.model,content:[content],stop_reason:reason,usage:{input_tokens:10,output_tokens:5}};
  if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  const events=[{type:'message_start',message:{...result,content:[],stop_reason:null}}, {type:'content_block_start',index:0,content_block:call?{...content,input:{}}:{type:'text',text:''}}, {type:'content_block_delta',index:0,delta:call?{type:'input_json_delta',partial_json:'{}'}:{type:'text_delta',text:'OK'}}, {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:reason,stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}];
  for(const e of events)res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);res.end();
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const env: NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:dir,HAPPY_HOME_DIR:join(dir,'happy'),CLAUDE_CONFIG_DIR:join(dir,'claude'),HAPPY_AI_AUTH_SOURCE:'personal-endpoint',HAPPY_AI_AUTH_PERSONAL_ENDPOINT_BINDING:JSON.stringify({endpointId:'e',generation:1,ownerUserId:'a',issuer:'https://studio.example.test',machineId:'pc',name:'Fixture',model:'fixture-model'}),ANTHROPIC_BASE_URL:`http://127.0.0.1:${(server.address() as {port:number}).port}/inference/probe`,ANTHROPIC_AUTH_TOKEN:'fixture-relay-token',ANTHROPIC_MODEL:'fixture-model',ANTHROPIC_DEFAULT_SONNET_MODEL:'fixture-model',ANTHROPIC_DEFAULT_HAIKU_MODEL:'fixture-model',CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'};
Object.assign(env, buildPersonalEndpointEnvironment({kind:'personal-endpoint',issuer:'https://studio.example.test',ownerUserId:'a',endpointId:'e',generation:1,ticket:'a'.repeat(43)}, 'pc', {version:1,leaseId:'probe',baseUrl:env.ANTHROPIC_BASE_URL,relayToken:'fixture-relay-token',name:'Fixture',model:'fixture-model',workspace:{projectId:'project'},purpose:'test',modelTiers:{},maxContextTokens:32768,apiTimeoutMs:30000}));
const child=spawn(process.execPath,[join(projectPath(),'dist/index.mjs'),'personal-endpoint-probe'],{env,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
const timer=setTimeout(()=>child.kill('SIGKILL'),45000);
const code=await new Promise(r=>child.on('exit',r));clearTimeout(timer);
try {
expect(stderr).not.toContain('fixture-private-token');
if (scenario !== 'success') { expect(code).toBe(1); expect(endpointProbeFailure(stdout.trim()), JSON.stringify({code,stdout,stderr})).toBe(scenario === 'auth' ? 'PERSONAL_ENDPOINT_AUTHENTICATION_FAILED' : 'PERSONAL_ENDPOINT_TOOL_CALL_FAILED'); return; }
expect({code,stderr}).toEqual({code:0,stderr:''});
expect(validateEndpointProbeResult(stdout.trim())).toBe(true);
expect(toolUsed).toBe(true);
expect(requests).toHaveLength(2);
expect(requests.every(r=>r.auth==='Bearer fixture-relay-token' && r.model==='fixture-model' && r.stream===true)).toBe(true);
} finally {
server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});

}
}, 60_000)
