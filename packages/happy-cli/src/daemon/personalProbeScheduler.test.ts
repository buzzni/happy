import {describe,expect,it,vi} from 'vitest'
import {createPersonalProbeScheduler,hasActiveClaudeUse} from './personalProbeScheduler'
function setup() {
 let now=1000000,online=true,active=true
 let rows:any[]=[{accountRef:'ref',credentialGeneration:1,scope:'personal',enabled:false,ackCost:false,credentialType:'setup_token',eligibility:'disabled',budget:{remaining:96,machineRemaining:288,retryAt:null}}]
 const collect=vi.fn(async(_row:any,_signal:AbortSignal)=>{})
 const roster=vi.fn(async()=>rows)
 const scheduler=createPersonalProbeScheduler({now:()=>now,online:()=>online,inUse:()=>active,roster,collect})
 return {scheduler,collect,rows,reads:()=>roster.mock.calls.length,advance:(n:number)=>{now+=n},offline:()=>{online=false},inactive:()=>{active=false},active:()=>{active=true},replace:()=>{rows=[{...rows[0],credentialGeneration:2}]}}
}
describe('resident personal scheduler',()=>{
 it('defaults off, requires online Claude use, and waits15min between starts',async()=>{
  const s=setup();await s.scheduler.tick();expect(s.collect).not.toHaveBeenCalled()
  // Consent goes through the runtime, which invalidates the roster it read.
  Object.assign(s.rows[0],{enabled:true,ackCost:true,eligibility:'eligible'});s.scheduler.invalidate()
  await s.scheduler.tick();await Promise.resolve();expect(s.collect).toHaveBeenCalledTimes(1)
  s.advance(899999);await s.scheduler.tick();expect(s.collect).toHaveBeenCalledTimes(1)
  s.advance(1);await s.scheduler.tick();expect(s.collect).toHaveBeenCalledTimes(2)
  s.inactive();s.advance(900000);await s.scheduler.tick();expect(s.collect).toHaveBeenCalledTimes(2)
 })
 it.each(['revoke','replacement','offline','inactivity','disabled','close'])('aborts pending transport on %s without starting a second',async(kind)=>{
  const s=setup();Object.assign(s.rows[0],{enabled:true,ackCost:true,eligibility:'eligible'})
  let signal:AbortSignal|undefined;s.collect.mockImplementation(async(_row,abort)=>{signal=abort;await new Promise<void>(resolve=>abort.addEventListener('abort',()=>resolve()))})
  await s.scheduler.tick();expect(signal?.aborted).toBe(false)
  if(kind==='revoke')s.rows[0].enabled=false
  if(kind==='replacement')s.replace()
  if(kind==='disabled')s.rows[0].eligibility='account-disabled'
  if(kind==='offline')s.offline()
  if(kind==='inactivity')s.inactive()
  if(kind==='close')s.scheduler.close()
  else await s.scheduler.tick()
  expect(signal?.aborted).toBe(true);expect(s.collect).toHaveBeenCalledTimes(1)
 })
 it('never collects managed, budget exhausted or backing-off rows and serializes candidates',async()=>{
  const s=setup();Object.assign(s.rows[0],{enabled:true,ackCost:true,eligibility:'eligible',scope:'organization'})
  await s.scheduler.tick();expect(s.collect).not.toHaveBeenCalled()
  s.rows[0].scope='personal';s.rows[0].budget.remaining=0;s.scheduler.invalidate()
  await s.scheduler.tick();expect(s.collect).not.toHaveBeenCalled()
  s.rows[0].budget.remaining=96;s.rows[0].budget.retryAt=2000000;s.scheduler.invalidate()
  await s.scheduler.tick();expect(s.collect).not.toHaveBeenCalled()
  s.rows[0].budget.retryAt=null;s.rows.push({...s.rows[0],accountRef:'other'});s.scheduler.invalidate()
  let finish!:()=>void;s.collect.mockImplementation(async()=>new Promise<void>(resolve=>finish=resolve))
  await s.scheduler.tick();await s.scheduler.tick();expect(s.collect).toHaveBeenCalledTimes(1)
  finish();await Promise.resolve();await Promise.resolve();await s.scheduler.tick();expect(s.collect).toHaveBeenCalledTimes(2)
 })
 // 2026-11-24: the daemon ticks every 5s while Claude is in use, and each roster read starts cswap (Python) twice. With no
 // personal probe consented that was ~24 Python starts a minute for nothing.
 it('reuses a roster read: ten minutes while no personal probe can run, one minute while one can',async()=>{
  const s=setup()
  for(let i=0;i<12;i++){await s.scheduler.tick();s.advance(5000)}
  expect(s.reads()).toBe(1)
  s.advance(600000);await s.scheduler.tick();expect(s.reads()).toBe(2)
  // Consented, but its budget is spent: nothing starts, the roster is read once a minute.
  Object.assign(s.rows[0],{enabled:true,ackCost:true,eligibility:'eligible',budget:{...s.rows[0].budget,remaining:0}});s.scheduler.invalidate()
  await s.scheduler.tick();expect(s.reads()).toBe(3)
  s.advance(59999);await s.scheduler.tick();expect(s.reads()).toBe(3)
  s.advance(1);await s.scheduler.tick();expect(s.reads()).toBe(4)
  expect(s.collect).not.toHaveBeenCalled()
 })
 it('reads again after invalidation, when Claude use starts again, and on every tick of a running collect',async()=>{
  const s=setup();await s.scheduler.tick();await s.scheduler.tick();expect(s.reads()).toBe(1)
  s.scheduler.invalidate();await s.scheduler.tick();expect(s.reads()).toBe(2)
  s.inactive();await s.scheduler.tick();s.active();await s.scheduler.tick();expect(s.reads()).toBe(3)
  Object.assign(s.rows[0],{enabled:true,ackCost:true,eligibility:'eligible'});s.scheduler.invalidate()
  s.collect.mockImplementation(async(_row,abort)=>new Promise<void>(resolve=>abort.addEventListener('abort',()=>resolve())))
  await s.scheduler.tick();await s.scheduler.tick();await s.scheduler.tick();expect(s.reads()).toBe(6)
  s.scheduler.close()
 })
})

it('requires fresh alive Claude reports with actual use, not global account selection',()=>{
 const session={pid:1,happySessionMetadataFromLocalWebhook:{flavor:'claude'},runtime:{updatedAt:1000000,thinking:true,hasOpenToolCall:false}}
 expect(hasActiveClaudeUse([session],1000000,()=>true)).toBe(true)
 expect(hasActiveClaudeUse([session],1120001,()=>true)).toBe(false)
 expect(hasActiveClaudeUse([session],1000000,()=>false)).toBe(false)
 expect(hasActiveClaudeUse([{...session,happySessionMetadataFromLocalWebhook:{flavor:'codex'}}],1000000,()=>true)).toBe(false)
 expect(hasActiveClaudeUse([{...session,runtime:undefined}],1000000,()=>true)).toBe(false)
 expect(hasActiveClaudeUse([{...session,runtime:{...session.runtime,thinking:false}}],1000000,()=>true)).toBe(false)
})

it('rejects duplicate stable refs and cancels an existing flight',async()=>{
 const s=setup();Object.assign(s.rows[0],{enabled:true,ackCost:true,eligibility:'eligible'})
 let signal!:AbortSignal
 s.collect.mockImplementation(async(_row,abort)=>{signal=abort;await new Promise<void>(r=>abort.addEventListener('abort',()=>r()))})
 await s.scheduler.tick();s.rows.push({...s.rows[0],credentialGeneration:2})
 await s.scheduler.tick();expect(signal.aborted).toBe(true);expect(s.collect).toHaveBeenCalledTimes(1)
})
