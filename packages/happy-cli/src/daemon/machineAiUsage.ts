/**
 * aplus-dev-studio specs/work-machine-migration — `machine-ai-usage`, the
 * Claude and Codex usage Studio's chat polls every five minutes.
 *
 * Studio used to send this script through `bash`. A work machine counts every
 * `bash` as new work, so the poll alone recorded a migrated machine's first
 * execution and closed the way back. The script is now fixed here; the caller
 * chooses only whether the Claude writer starts protected. It reads, without
 * writing credentials: `~/.aplus/cli-tools.v1.json`, claude-swap
 * (`token-runtime capabilities|status`, `list --json`), the Claude login
 * (`CLAUDE_CODE_OAUTH_TOKEN`, `.credentials.json` or the macOS keychain) for
 * the Anthropic usage API, `~/.codex/auth.json` for the ChatGPT usage API, and
 * codex-multi-auth (`limits --json [--refresh]`, `list --json`) with its
 * account and quota cache files. It prints the JSON Studio's
 * `parseMachineUsagePayload` reads.
 *
 * Kept byte for byte with web-ui `src/lib/sync/machineUsage.ts` USAGE_SCRIPT,
 * which remains Studio's fallback for daemons without this method.
 */
import type { MetadataDeps } from './machineMetadataMethods';
import { sanitizeChildEnv } from '@/utils/childEnv';

export const MACHINE_AI_USAGE_METHOD = 'machine-ai-usage';

/** web-ui `src/lib/sync/cswapEnvScript.ts`: the uv tool bin first on PATH, as withUvToolBinOnPath. */
const CSWAP_ENV_SCRIPT = 'const cswapEnv=(()=>{const p=require("path"),e=process.env,b=e.UV_TOOL_BIN_DIR||e.XDG_BIN_HOME||(e.XDG_DATA_HOME?p.join(e.XDG_DATA_HOME,"..","bin"):p.join(require("os").homedir(),".local","bin")),k=Object.keys(e).find(x=>x.toUpperCase()==="PATH")||"PATH";return{...e,[k]:[b,...String(e[k]||"").split(p.delimiter).filter(x=>x&&x!==b)].join(p.delimiter)}})();';

const CSWAP_COMMAND_RUNTIME = `const cswap=(args,timeout)=>{const fs=require("fs"),path=require("path"),home=require("os").homedir(),windows=process.platform==="win32";let tools={};try{tools=JSON.parse(fs.readFileSync(path.join(home,".aplus","cli-tools.v1.json"),"utf8"))||{}}catch{}const py=tools.claudeSwapPython,site=tools.claudeSwapSitePackages,direct=windows&&typeof py==="string"&&typeof site==="string"&&fs.existsSync(py)&&fs.existsSync(site),recorded=tools["claude-swap"],command=typeof recorded==="string"&&fs.existsSync(recorded)?recorded:"cswap";return require("child_process").execFileSync(direct?py:command,direct?["-P","-m","claude_swap",...args]:args,{encoding:"utf8",stdio:["ignore","pipe","ignore"],timeout:windows?Math.max(timeout,60000):timeout,windowsHide:true,env:direct?{...cswapEnv,PYTHONPATH:site}:cswapEnv})};`

export const MACHINE_AI_USAGE_SCRIPT = `const fs=require("fs"),{execFileSync}=require("child_process");
${CSWAP_ENV_SCRIPT}
${CSWAP_COMMAND_RUNTIME}
const home=process.env.HOME||require("os").homedir();
const out={claude:[],claudeError:null,codex:null};
let codexAccountId=null,codexAuthToken=null;
const read=p=>{try{return JSON.parse(fs.readFileSync(p,"utf8"))}catch{return null}};
const message=e=>e instanceof Error?e.message:String(e);
const claudeToken=()=>{if(process.env.CLAUDE_CODE_OAUTH_TOKEN)return process.env.CLAUDE_CODE_OAUTH_TOKEN;const file=read((process.env.CLAUDE_CONFIG_DIR||home+"/.claude")+"/.credentials.json"),fromFile=file?.claudeAiOauth?.accessToken;if(fromFile)return fromFile;if(process.platform!=="darwin")return null;const variants=process.env.USER?[["find-generic-password","-s","Claude Code-credentials","-a",process.env.USER,"-w"],["find-generic-password","-s","Claude Code-credentials","-w"]]:[["find-generic-password","-s","Claude Code-credentials","-w"]];for(const args of variants)try{const raw=execFileSync("/usr/bin/security",args,{encoding:"utf8",stdio:["ignore","pipe","ignore"],timeout:10000}),blob=JSON.parse(raw.trim()),token=blob?.claudeAiOauth?.accessToken;if(token)return token}catch{}return null};
let enhancedClaude=false;
const run=async()=>{
 try{const cap=JSON.parse(cswap(["token-runtime","capabilities"],8000));if(cap.artifact!==undefined||cap.setupTokenObservation!==undefined){enhancedClaude=true;if(cap.version!==1||cap.artifact!=="saycode-setup-token-runtime-v1"||cap.setupTokenObservation!==true||cap.managedAccountMetadata!==true)throw Error("Claude runtime capability unavailable");out.claudeRuntime=JSON.parse(cswap(["token-runtime","status"],8000))}}catch(e){if(enhancedClaude)out.claudeError="Claude runtime status unavailable"};
 try{const raw=cswap(["list","--json"],20000),data=JSON.parse(raw);if(data.error)throw new Error(data.error.message||"claude-swap failed");out.claude=(Array.isArray(data.accounts)?data.accounts:[]).map(a=>({id:String(a.number??a.email),roster:{number:a.number,email:a.email,organizationUuid:a.organizationUuid||"",uuid:a.uuid||""},label:a.displayName||a.alias||(a.credentialType==="setup_token"||a.managedAccountId?null:a.email)||("Account "+a.number),active:a.credentialType!=="setup_token"&&!a.managedAccountId&&a.active===true,...(enhancedClaude||a.credentialType==="setup_token"||a.managedAccountId?{selectable:false,credentialType:a.credentialType,managedAccountId:a.managedAccountId,credentialGeneration:a.credentialGeneration}:{}),usageAgeSeconds:a.usageAgeSeconds,usageFetchedAt:a.usageFetchedAt,disabled:a.disabled===true,status:a.usageStatus&&a.usageStatus!=="ok"?a.usageStatus:null,fiveHour:a.usage?.fiveHour||{},sevenDay:a.usage?.sevenDay||{}}))}catch(e){out.claudeError=message(e)};
 if(!enhancedClaude&&!out.claude.some(a=>a.credentialType==="setup_token"||a.managedAccountId)&&!out.claude.length)try{const token=claudeToken();if(!token)throw new Error("Claude login or claude-swap account not found");const r=await fetch("https://api.anthropic.com/api/oauth/usage",{signal:AbortSignal.timeout(10000),headers:{Authorization:"Bearer "+token,"anthropic-beta":"oauth-2025-04-20","User-Agent":"claude-code/2.1.121"}});if(!r.ok)throw new Error("Claude HTTP "+r.status);const x=await r.json();if(x.error||(!x.five_hour&&!x.seven_day))throw new Error(x.error?.message||"Claude usage parse error");out.claude=[{id:"current",label:"Current Claude account",active:true,disabled:false,status:null,fiveHour:{pct:x.five_hour?.utilization,resetsAt:x.five_hour?.resets_at||null},sevenDay:{pct:x.seven_day?.utilization,resetsAt:x.seven_day?.resets_at||null}}];out.claudeError=null}catch(e){out.claudeError=message(e)};
 try{const auth=read(home+"/.codex/auth.json"),token=auth?.tokens?.access_token;codexAccountId=typeof auth?.tokens?.account_id==="string"?auth.tokens.account_id:null;codexAuthToken=token;if(!token)throw new Error("Codex login not found");const r=await fetch("https://chatgpt.com/backend-api/wham/usage",{signal:AbortSignal.timeout(10000),headers:{Authorization:"Bearer "+token,...(auth.tokens.account_id?{"ChatGPT-Account-ID":auth.tokens.account_id}:{})}});if(!r.ok)throw new Error("Codex HTTP "+r.status);const x=await r.json();if(!x.rate_limit)throw new Error("Codex usage parse error");const q=x.rate_limit,win=w=>({pct:w?.used_percent,resetsAt:w?.reset_at?new Date(w.reset_at*1000).toISOString():null}),primary=win(q.primary_window),secondary=win(q.secondary_window),weekly=(q.primary_window?.limit_window_seconds||0)>=518400;out.codex=weekly?{fiveHour:{},sevenDay:primary,error:null}:{fiveHour:primary,sevenDay:secondary,error:null}}catch(e){out.codex={fiveHour:{},sevenDay:{},error:message(e)}};
 try{const path=require("path"),tool=read(path.join(home,".aplus","cli-tools.v1.json"))?.["codex-multi-auth"],direct=typeof tool==="string"&&fs.existsSync(tool),ma=args=>execFileSync(direct?process.execPath:"codex-multi-auth",direct?[tool,...args]:args,{encoding:"utf8",stdio:["ignore","pipe","ignore"],timeout:12000,env:cswapEnv,shell:!direct&&process.platform==="win32",windowsHide:true});let pool;try{pool=JSON.parse(ma(["limits","--json","--refresh"]))}catch{try{pool=JSON.parse(ma(["limits","--json"]))}catch{}}if(!pool||pool.schemaVersion!==1||!Array.isArray(pool.accounts)){const listing=JSON.parse(ma(["list","--json"])),store=read(path.join(home,".codex","multi-auth","openai-codex-accounts.json")),cache=read(path.join(home,".codex","multi-auth","quota-cache.json")),stored=Array.isArray(store?.accounts)&&store.accounts.length===listing.accounts?.length?store.accounts:[];pool={schemaVersion:1,selection:{pinnedIndex:listing.pinnedAccountIndex},accounts:listing.accounts.map(a=>({...a,quota:stored[a.index]?.accountId?cache?.byAccountId?.[stored[a.index].accountId]:null}))}}if(pool.schemaVersion===1&&Array.isArray(pool.accounts)){const stored=read(require("path").join(require("os").homedir(),".codex","multi-auth","openai-codex-accounts.json")),labels=Array.isArray(stored?.accounts)&&stored.accounts.length===pool.accounts.length?stored.accounts:[];out.codexAccounts=pool.accounts.map(a=>{const q=a.quota||{},windows={fiveHour:{},sevenDay:{}};for(const w of [q.primary,q.secondary]){if(!w||typeof w.windowMinutes!=="number"||w.windowMinutes<=0)continue;windows[w.windowMinutes>=8640?"sevenDay":"fiveHour"]={pct:w.usedPercent,resetsAt:typeof w.resetAtMs==="number"?new Date(w.resetAtMs).toISOString():null}}return{id:String(a.index),label:labels[a.index]?.email||a.label||("Account "+(a.index+1)),active:a.current===true,disabled:a.enabled===false,pinned:pool.selection?.pinnedIndex===a.index,status:typeof q.updatedAt==="number"&&Number.isFinite(q.updatedAt)&&Date.now()>=q.updatedAt&&Date.now()-q.updatedAt<=1800000?null:"usage_stale",...windows}});
 const knownIds=labels.some(a=>typeof a?.accountId==="string"&&a.accountId.length>0);
 const fallbackAuth=knownIds?null:read(home+"/.codex/auth.json")?.tokens;
 const sameFallbackAuth=fallbackAuth&&fallbackAuth.access_token===codexAuthToken&&(typeof fallbackAuth.account_id==="string"?fallbackAuth.account_id:null)===codexAccountId;
 const liveIndex=knownIds?(codexAccountId?pool.accounts.findIndex(a=>labels[a.index]?.accountId===codexAccountId):-1):sameFallbackAuth?pool.accounts.findIndex(a=>a.current===true):-1;
 const row=out.codexAccounts[liveIndex];
 if(row&&out.codex&&!out.codex.error){
  let observed=false;
  for(const kind of ["fiveHour","sevenDay"]){const live=out.codex[kind];if(live&&typeof live.pct==="number"&&Number.isFinite(live.pct)){row[kind]=live;observed=true}}
  if(observed)row.status=null;
 }
 }}catch{};
 out.claudeWriterProtected=enhancedClaude;console.log(JSON.stringify(out));
};run();`

export interface MachineAiUsageDeps {
    runFile: MetadataDeps['runFile'];
    /** The node binary running this daemon. */
    nodePath: string;
    platform: string;
}

type Answer = Record<string, unknown>;

export function createMachineAiUsageHandler(deps: MachineAiUsageDeps): (params: unknown) => Promise<Answer> {
    return async (params) => {
        const protectClaude = (params as { protectClaude?: unknown } | null)?.protectClaude === true;
        const script = protectClaude
            ? MACHINE_AI_USAGE_SCRIPT.replace('let enhancedClaude=false;', 'let enhancedClaude=true;')
            : MACHINE_AI_USAGE_SCRIPT;
        let result: Awaited<ReturnType<MetadataDeps['runFile']>>;
        try {
            result = await deps.runFile(deps.nodePath, ['-e', script], {
                // The same environment the `bash` RPC gave this script.
                env: sanitizeChildEnv(process.env, { boundary: 'session' }),
                timeoutMs: deps.platform === 'win32' ? 150_000 : 45_000,
            });
        } catch (error) {
            return { success: false, errorCode: 'USAGE_FAILED', error: error instanceof Error ? error.message : 'Usage script could not start' };
        }
        if (result.code !== 0) {
            return { success: false, errorCode: 'USAGE_FAILED', error: result.stderr.trim() || 'Usage script failed' };
        }
        try {
            const usage: unknown = JSON.parse(result.stdout);
            if (usage && typeof usage === 'object' && !Array.isArray(usage)) return { success: true, usage };
        } catch { /* Answered below. */ }
        return { success: false, errorCode: 'USAGE_FAILED', error: 'Usage script printed no JSON object' };
    };
}
