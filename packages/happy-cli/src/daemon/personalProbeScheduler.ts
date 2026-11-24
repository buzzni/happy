/** Resident Core scheduler; consent and spending remain provider-owned. */
export type PersonalProbeCandidate = {accountRef:string;credentialGeneration:number;scope:string;enabled:boolean;ackCost:boolean;credentialType:string;eligibility:string;budget:{remaining:number;machineRemaining:number;retryAt:number|null}}
type Deps = {now():number;online():boolean;inUse():boolean;roster():Promise<PersonalProbeCandidate[]>;collect(row:PersonalProbeCandidate,signal:AbortSignal):Promise<unknown>}
/**
 * How long a roster read is reused while no collect runs. A read starts cswap (Python) twice and the daemon ticks every 5s
 * while Claude is in use (2026-11-24: ~24 Python starts a minute on a PC with no personal probe consented). A collect starts
 * at most every 15 minutes per account, so a minute is soon enough while one can run, ten while none can. Consent and
 * credential changes invalidate the read; a running collect still rereads every tick so a revocation stops it at once.
 */
export const PERSONAL_ROSTER_REUSE_MS=60_000
export const PERSONAL_ROSTER_IDLE_REUSE_MS=600_000
export function createPersonalProbeScheduler(deps:Deps) {
 const next=new Map<string,number>();let closed=false,reading=false
 let flight:{row:PersonalProbeCandidate;controller:AbortController}|null=null
 let cached:{at:number;rows:PersonalProbeCandidate[]}|null=null
 const permitted=(r:PersonalProbeCandidate)=>r.scope==='personal'&&r.enabled&&r.ackCost&&r.credentialType==='setup_token'&&!['disabled','managed','account-disabled','scope-missing'].includes(r.eligibility)
 function cancel(ref?:string){if(flight&&(!ref||flight.row.accountRef===ref))flight.controller.abort()}
 function invalidate(){cached=null}
 async function roster() {
  const at=deps.now()
  if(!flight&&cached&&at-cached.at<(cached.rows.some(permitted)?PERSONAL_ROSTER_REUSE_MS:PERSONAL_ROSTER_IDLE_REUSE_MS))return cached.rows
  const rows=await deps.roster();cached={at,rows};return rows
 }
 async function tick() {
  if(closed)return
  // A new period of Claude use starts from a fresh read.
  if(!deps.online()||!deps.inUse()){invalidate();cancel();return}
  if(reading)return
  reading=true
  try {
   const rows=await roster()
   if(new Set(rows.map(r=>r.accountRef)).size!==rows.length){cancel();return}
   if(closed||!deps.online()||!deps.inUse()){cancel();return}
   if(flight){
    const current=rows.find(r=>r.accountRef===flight!.row.accountRef&&r.credentialGeneration===flight!.row.credentialGeneration)
    if(!current||!permitted(current))cancel()
    return
   }
   const now=deps.now()
   const row=rows.filter(r=>permitted(r)&&r.eligibility==='eligible'&&r.budget.remaining>0&&r.budget.machineRemaining>0&&(!r.budget.retryAt||r.budget.retryAt<=now)&&now>=(next.get(r.accountRef)??0)).sort((a,b)=>a.accountRef.localeCompare(b.accountRef))[0]
   if(!row)return
   const current={row,controller:new AbortController()};flight=current
   next.set(row.accountRef,now+900000)
   // Shared runtime serialization plus provider singleflight includes org probes.
   void deps.collect(row,current.controller.signal).catch(()=>undefined).finally(()=>{if(flight===current)flight=null})
  }catch{cancel()}finally{reading=false}
 }
 return {tick,cancel,invalidate,close:()=>{closed=true;cancel()},running:()=>Boolean(flight)}
}
/** Only fresh, live Claude reports with actual use qualify; stale/recovered is unknown. */
export function hasActiveClaudeUse(sessions:ReadonlyArray<{pid:number;happySessionMetadataFromLocalWebhook?:{flavor?:string};runtime?:{updatedAt:number;thinking:boolean;hasOpenToolCall:boolean;pendingUserInput?:boolean;lastUserInteractionAt?:number}}>,now:number,alive:(pid:number)=>boolean):boolean {
 return sessions.some(s=>s.happySessionMetadataFromLocalWebhook?.flavor==='claude'&&alive(s.pid)&&s.runtime&&now>=s.runtime.updatedAt&&now-s.runtime.updatedAt<=120000&&(s.runtime.thinking||s.runtime.hasOpenToolCall||s.runtime.pendingUserInput===true||(typeof s.runtime.lastUserInteractionAt==='number'&&now>=s.runtime.lastUserInteractionAt&&now-s.runtime.lastUserInteractionAt<900000)))
}
