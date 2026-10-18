import { describe, expect, it, vi } from 'vitest'
import { createCredentialGroupSync } from './aiCredentialGroups'
function setup() {
  let journal:string|null=null
  const installed=new Set(['personal'])
  const deps={read:async()=>journal,write:vi.fn(async(value:string)=>{journal=value}),snapshot:async()=>[...installed],incoming:(_provider:string,payload:string)=>JSON.parse(payload) as string[],appliedCredentials:(_provider:string,payload:string)=>JSON.parse(payload).map((managedAccountId:string, index:number)=>({managedAccountId,credentialGeneration:index+1})),apply:vi.fn(async(_provider:string,payload:string)=>{for(const id of JSON.parse(payload))installed.add(id)}),remove:vi.fn(async(_provider:string,ids:string[])=>{ids.forEach(id=>installed.delete(id))})}
  const sync=createCredentialGroupSync(deps)
  const input=(generation:number,payload:string|null,scope='company')=>({version:1 as const,provider:'claude' as const,scope,userId:'user',generation,fingerprint:String(generation).padStart(64,'a'),payload})
  return {deps,installed,sync,input,restart:()=>createCredentialGroupSync(deps)}
}
/** Org-managed setup-tokens are the `managed-*` identities; `metadata` holds the local slots that carry managed metadata. */
function managedSetup(extra:{inUse?:(provider:string)=>Promise<string[]>}={}) {
  const base=setup()
  const metadata=new Set<string>()
  const managedDeps={...base.deps,
    managedIdentities:(_provider:string,payload:string)=>(JSON.parse(payload) as string[]).filter(id=>id.startsWith('managed-')),
    managedInstalled:vi.fn(async()=>[...base.installed].filter(id=>metadata.has(id)).map(identity=>({identity,aliases:[] as string[]}))),
    apply:vi.fn(async(provider:string,payload:string,owned:string[])=>{await base.deps.apply(provider,payload);for(const id of JSON.parse(payload) as string[])if(id.startsWith('managed-'))metadata.add(id);return owned}),...extra}
  const create=()=>createCredentialGroupSync(managedDeps)
  return {...base,deps:managedDeps,metadata,sync:create(),restart:create}
}
describe('scoped credential group synchronization',()=>{
  it('does not acknowledge a preserved receipt after the account pool was cleared',async()=>{
    const {sync,input,installed,restart}=setup()
    const operation=input(1,'["shared"]')
    await sync.sync(operation)
    installed.delete('shared')
    expect(await restart().receipt('company','claude')).toMatchObject({reconciled:false})
    await restart().sync(operation)
    expect(await restart().receipt('company','claude')).toMatchObject({reconciled:true})
  })
  it('records introduced accounts only and preserves personal credentials on revoke',async()=>{
    const {sync,input,installed,deps}=setup()
    const receipt = await sync.sync(input(1,JSON.stringify(['personal','shared'])))
    expect(receipt.appliedCredentials).toEqual([
      { managedAccountId: 'personal', credentialGeneration: 1 },
      { managedAccountId: 'shared', credentialGeneration: 2 },
    ])
    expect(deps.write).toHaveBeenCalledBefore(deps.apply)
    await sync.sync(input(2,null))
    expect([...installed]).toEqual(['personal'])
    expect(deps.remove).toHaveBeenCalledWith('claude',['shared'])
  })
  it('preserves another valid assignment and removes the shared slot after the last revoke',async()=>{
    const {sync,input,installed}=setup()
    await sync.sync(input(1,'["shared"]','a'))
    await sync.sync(input(1,'["shared"]','b'))
    await sync.sync(input(2,null,'a'))
    expect(installed.has('shared')).toBe(true)
    await sync.sync(input(2,null,'b'))
    expect(installed.has('shared')).toBe(false)
  })
  it('rejects stale or conflicting generation and replays a completed operation without reimport',async()=>{
    const {sync,input,deps}=setup()
    const first=input(2,'["shared"]')
    await sync.sync(first)
    expect(await sync.sync(first)).toMatchObject({reconciled:true,generation:2})
    expect(deps.apply).toHaveBeenCalledTimes(1)
    await expect(sync.sync(input(1,null))).rejects.toThrow('AI_GROUP_GENERATION_STALE')
    await expect(sync.sync({...first,payload:null,fingerprint:'b'.repeat(64)})).rejects.toThrow('AI_GROUP_GENERATION_CONFLICT')
  })
  it('persists assignment generation and lease correlation across restart and rejects lease replay conflicts',async()=>{
    const {sync,input,restart}=setup()
    const first={...input(2,'["shared"]'),assignmentGeneration:2,leaseId:'lease-a'}
    expect(await sync.sync(first)).toMatchObject({assignmentGeneration:2,leaseId:'lease-a'})
    expect(await restart().receipt('company','claude')).toMatchObject({assignmentGeneration:2,leaseId:'lease-a'})
    await expect(sync.sync({...first,leaseId:'lease-b'})).rejects.toThrow('AI_GROUP_LEASE_CONFLICT')
    await expect(sync.sync({...first,generation:1,assignmentGeneration:1,leaseId:'lease-a'})).rejects.toThrow('AI_GROUP_GENERATION_STALE')
  })
  it('recovers introduced account custody when an import was interrupted',async()=>{
    const {sync,input,deps,installed,restart}=setup()
    deps.apply.mockImplementationOnce(async()=>{installed.add('shared');throw new Error('interrupted')})
    await expect(sync.sync(input(1,'["shared"]'))).rejects.toThrow('interrupted')
    await restart().sync(input(2,null))
    expect([...installed]).toEqual(['personal'])
  })
  it('does not revoke OAuth accounts taken over by a later manual credential apply',async()=>{
    const {sync,input,installed}=setup()
    await sync.sync(input(1,'["shared"]'))
    await sync.invalidate('claude',['shared'])
    expect(await sync.receipt('company','claude')).toMatchObject({reconciled:false})
    await sync.sync(input(2,null))
    expect(installed.has('shared')).toBe(true)
  })
  // Saycode specs/claude-setup-token-managed-sync R4: an OAuth repair/merge/replace never adopts an org-managed setup-token.
  it.each([['repair or replace',null],['merge touching it',['managed-a']]] as const)('still revokes its managed setup-tokens after an OAuth %s invalidated the group',async(_label,touched)=>{
    const {sync,input,installed}=managedSetup()
    await sync.sync(input(1,'["managed-a","shared"]'))
    await sync.invalidate('claude',touched===null?null:[...touched])
    expect(await sync.receipt('company','claude')).toMatchObject({reconciled:false})
    await sync.sync(input(2,null))
    expect(installed.has('managed-a')).toBe(false)
    expect(installed.has('personal')).toBe(true)
  })
  it('does not acknowledge incomplete removal or replace a corrupted journal',async()=>{
    const {sync,input,deps}=setup()
    await sync.sync(input(1,'["shared"]'))
    deps.remove.mockResolvedValue(undefined)
    await expect(sync.sync(input(2,null))).rejects.toThrow('AI_GROUP_REMOVAL_INCOMPLETE')
    const corrupt=createCredentialGroupSync({...deps,read:async()=>'{broken'})
    const writes=deps.write.mock.calls.length
    await expect(corrupt.sync(input(3,null))).rejects.toThrow('AI_GROUP_JOURNAL_INVALID')
    expect(deps.write).toHaveBeenCalledTimes(writes)
  })
  it('authorizes only a reconciled desired owned identity for exact company and user',async()=>{
    const {sync,input}=setup()
    const request=input(1,'["shared"]')
    await sync.sync(request)
    expect(await sync.authorize(request.scope,request.userId,'shared')).toBe(true)
    expect(await sync.authorize('other',request.userId,'shared')).toBe(false)
    expect(await sync.authorize(request.scope,'other','shared')).toBe(false)
    expect(await sync.authorize(request.scope,request.userId,'personal')).toBe(false)
    await sync.invalidate('claude',[])
    expect(await sync.authorize(request.scope,request.userId,'shared')).toBe(false)
  })

  // Shared-machine collector: the machine is the principal, so custody is read from its own entry only.
  it('authorizes a machine principal only from that machine entry',async()=>{
    const {sync,input}=setup()
    const machine={version:1 as const,scope:'company',principalType:'machine' as const,machineId:'machine-1',provider:'claude' as const,generation:1,fingerprint:'c'.repeat(64),payload:'["shared"]'}
    await sync.sync(input(1,'["user-account"]'))
    await sync.sync(machine)
    expect(await sync.authorizeMachine('company','machine-1','shared')).toBe(true)
    expect(await sync.authorizeMachine('company','machine-2','shared')).toBe(false)
    expect(await sync.authorizeMachine('other','machine-1','shared')).toBe(false)
    // Neither principal borrows the other's custody.
    expect(await sync.authorizeMachine('company','machine-1','user-account')).toBe(false)
    expect(await sync.authorize('company','machine-1','shared')).toBe(false)
    expect(await sync.authorize('company','user','shared')).toBe(false)
    await sync.invalidate('claude',[])
    expect(await sync.authorizeMachine('company','machine-1','shared')).toBe(false)
  })

  it('keeps a machine principal separate from user assignments and returns a machine receipt',async()=>{
    const {sync,input,deps}=setup()
    const machine={version:1 as const,scope:'company',principalType:'machine' as const,machineId:'machine-1',provider:'claude' as const,generation:1,fingerprint:'c'.repeat(64),payload:'["shared"]'}
    await sync.sync(input(1,'["user-account"]'))
    await expect(sync.sync(machine)).resolves.toMatchObject({
      scope:'company',principalType:'machine',machineId:'machine-1',generation:1,reconciled:true,
    })
    expect(await sync.receipt('company','claude',{principalType:'machine',machineId:'machine-1',userId:'machine-1'})).toMatchObject({
      principalType:'machine',machineId:'machine-1',payloadDigest:expect.any(String),
    })
    expect(await sync.receipt('company','claude')).toMatchObject({userId:'user'})
    expect(deps.apply).toHaveBeenCalledTimes(2)
  })

  it('replaces the previous user when a scope is reassigned to a different user',async()=>{
    const {sync,input,installed}=setup()
    await sync.sync({...input(1,'["shared-a"]'),userId:'alice'})
    await expect(sync.sync({...input(1,'["shared-b"]'),userId:'bob'})).rejects.toThrow('AI_GROUP_GENERATION_CONFLICT')
    await sync.sync({...input(2,'["shared-b"]'),userId:'bob'})
    expect(installed.has('shared-a')).toBe(false)
    expect(await sync.assignment('company','claude')).toMatchObject({userId:'bob',desired:['shared-b']})
    expect(await sync.authorize('company','alice','shared-a')).toBe(false)
    expect(await sync.receipt('company','claude')).toMatchObject({userId:'bob',generation:2})
    await expect(sync.sync({...input(1,'["shared-a"]'),userId:'alice'})).rejects.toThrow('AI_GROUP_GENERATION_STALE')
  })

  it('returns the user receipt, not a later machine receipt, when no principal is given',async()=>{
    const {sync,input}=setup()
    const machine={version:1 as const,scope:'company',principalType:'machine' as const,machineId:'machine-1',provider:'claude' as const,generation:1,fingerprint:'c'.repeat(64),payload:'["machine-account"]'}
    await sync.sync(input(1,'["user-account"]'))
    await sync.sync(machine)
    await sync.sync(input(2,'["user-account"]'))
    expect(await sync.receipt('company','claude')).toMatchObject({userId:'user',generation:2})
  })

  it('rejects a machine principal that carries a user id',async()=>{
    const {sync}=setup()
    await expect(sync.sync({version:1,scope:'company',principalType:'machine',machineId:'machine-1',userId:'user',provider:'claude',generation:1,fingerprint:'c'.repeat(64),payload:null} as never)).rejects.toThrow('AI_GROUP_INVALID_INPUT')
  })

})

describe('lost local accounts after reinstallation', () => {
  it.each(['claude', 'codex'] as const)('restores missing %s accounts from the same assignment while preserving personal accounts', async provider => {
    const { sync, input, installed, deps, restart } = setup()
    const request = { ...input(1, '["shared-a","shared-b"]'), provider }
    await sync.sync(request)
    installed.delete('shared-a')
    const resumed = restart()
    await expect(resumed.sync(request)).resolves.toMatchObject({ reconciled: true })
    expect(installed.has('shared-a')).toBe(true)
    expect(installed.has('personal')).toBe(true)
    expect(deps.apply).toHaveBeenCalledTimes(2)
    await resumed.sync({ ...request, generation: 2, fingerprint: 'b'.repeat(64), payload: null })
    expect([...installed]).toEqual(['personal'])
  })
})

it('preserves assignment generation and the new lease when reusing a complete local pool', async () => {
  const { sync, input } = setup()
  const first = { ...input(1, '["shared"]'), assignmentGeneration: 1, leaseId: 'lease-first' }
  await sync.sync(first)
  const next = { ...first, generation: 2, assignmentGeneration: 2, leaseId: 'lease-next' }
  await expect(sync.sync(next)).resolves.toMatchObject({ generation: 2, assignmentGeneration: 2, leaseId: 'lease-next', reconciled: true })
})

describe('several Saycode PC identities on one Windows profile', () => {
  // Studio counts generation per PC; one profile's journal is shared by every daemon identity on it.
  // Windows field report 2026-10-11: a new PC's generation 13 was refused against another PC's 23.
  it('lets another PC replace the slot but keeps rollback protection within the same PC', async () => {
    const { deps, installed, input } = setup()
    const pcA = createCredentialGroupSync({ ...deps, appliedMachineId: 'pc-a' })
    const pcB = createCredentialGroupSync({ ...deps, appliedMachineId: 'pc-b' })
    await pcA.sync({ ...input(23, '["shared-a"]'), userId: 'alice' })
    await expect(pcB.sync({ ...input(13, '["shared-b"]'), userId: 'bob' })).resolves.toMatchObject({ userId: 'bob', generation: 13, reconciled: true })
    expect(installed.has('shared-a')).toBe(false)
    expect(await pcB.assignment('company', 'claude')).toMatchObject({ userId: 'bob', desired: ['shared-b'] })
    await expect(pcB.sync({ ...input(12, '["shared-a"]'), userId: 'bob' })).rejects.toThrow('AI_GROUP_GENERATION_STALE')
  })

  // 2026-10-12: another daemon on the same OS home wrote a managed setup-token entry for its own
  // assignment, and every daemon there refused unbound Claude launches with SELECTION_REQUIRED.
  it('decides launches only from entries this PC applied, keeping unrecorded entries as its own', async () => {
    const { deps, input } = setup()
    const managed = { ...deps, managedIdentities: (_provider: string, payload: string) => JSON.parse(payload) as string[] }
    const pcA = createCredentialGroupSync({ ...managed, appliedMachineId: 'pc-a' })
    const pcB = createCredentialGroupSync({ ...managed, appliedMachineId: 'pc-b' })
    await pcA.sync({ ...input(1, '["managed-a"]', 'company-a'), userId: 'alice' })

    expect(await pcA.hasManagedDesired('claude')).toBe(true)
    expect(await pcB.hasManagedDesired('claude')).toBe(false)
    expect(await pcB.assignment('company-a', 'claude')).toBeNull()
    expect(await pcB.authorize('company-a', 'alice', 'managed-a')).toBe(false)
    expect(await pcA.authorize('company-a', 'alice', 'managed-a')).toBe(true)

    // An entry from before PCs were recorded may be this PC's own: it still decides.
    await createCredentialGroupSync(managed).sync({ ...input(1, '["managed-legacy"]', 'company-legacy'), userId: 'carol' })
    expect(await pcB.hasManagedDesired('claude')).toBe(true)
  })

  it('treats an entry written before PCs were recorded as replaceable by a PC that records itself', async () => {
    const { deps, input } = setup()
    await createCredentialGroupSync(deps).sync({ ...input(23, '["shared-a"]'), userId: 'alice' })
    await expect(createCredentialGroupSync({ ...deps, appliedMachineId: 'pc-b' }).sync({ ...input(13, '["shared-b"]'), userId: 'bob' }))
      .resolves.toMatchObject({ generation: 13 })
  })
})

// Saycode specs/claude-setup-token-managed-sync R2: ownership of an org-managed setup-token is re-acquired, never lost for good.
describe('managed setup-token ownership re-acquisition', () => {
  it('re-acquires a desired managed slot after the journal was lost, so a later change replaces it', async () => {
    const { sync, input, deps, installed } = managedSetup()
    await sync.sync(input(1, '["managed-a"]'))
    await deps.write(JSON.stringify({ version: 1, entries: [] }))
    await sync.sync(input(1, '["managed-a"]'))
    expect(await sync.authorize('company', 'user', 'managed-a')).toBe(true)
    expect(deps.apply).toHaveBeenLastCalledWith('claude', '["managed-a"]', ['managed-a'])
    await sync.sync(input(2, '["managed-b"]'))
    expect([...installed].sort()).toEqual(['managed-b', 'personal'])
  })

  it('does not re-acquire a managed slot another scope owns, nor a slot without managed metadata', async () => {
    const { sync, input, installed, metadata } = managedSetup()
    await sync.sync(input(1, '["managed-a"]', 'a'))
    await sync.sync(input(1, '["managed-a"]', 'b'))
    expect(await sync.authorize('b', 'user', 'managed-a')).toBe(false)
    installed.add('managed-bare')
    await sync.sync(input(2, '["managed-a","managed-bare"]', 'b'))
    expect(metadata.has('managed-bare')).toBe(true)
    expect(await sync.authorize('b', 'user', 'managed-bare')).toBe(false)
  })

  it('removes a managed setup-token it applied even when an old journal without managedHeld had lost its ownership', async () => {
    const { sync, input, deps, installed } = managedSetup()
    // A journal written before `managedHeld` existed, whose ownership an older repair cleared; the slot has no managed metadata yet.
    await deps.write(JSON.stringify({ version: 1, entries: [{ scope: 'company', principalType: 'user', userId: 'user', provider: 'claude', generation: 1,
      assignmentGeneration: 1, fingerprint: String(1).padStart(64, 'a'), payloadDigest: null, desired: ['managed-a'], managed: ['managed-a'], owned: [], pending: true }] }))
    installed.add('managed-a')
    await expect(sync.receipt('company', 'claude')).resolves.toMatchObject({ reconciled: false })
    await sync.sync(input(2, '["managed-a"]'))
    await sync.invalidate('claude', null)
    await sync.sync(input(3, null))
    expect([...installed]).toEqual(['personal'])
  })
})

// Saycode specs/claude-setup-token-managed-sync R1/R2: the managed setup-token slots match the assigned set exactly.
describe('orphan managed setup-token sweep', () => {
  it('replaces {A,B} by {B,C}: A removed, B kept, C added, personal and bare slots untouched', async () => {
    const { sync, input, installed } = managedSetup()
    installed.add('managed-bare')
    await sync.sync(input(1, '["managed-a","managed-b"]'))
    await sync.sync(input(2, '["managed-b","managed-c"]'))
    expect([...installed].sort()).toEqual(['managed-b', 'managed-bare', 'managed-c', 'personal'])
  })

  it('removes managed-format slots no journal entry desires after a setup-token apply', async () => {
    const { sync, input, installed, metadata, deps } = managedSetup()
    for (const id of ['managed-orphan', 'managed-bare']) installed.add(id)
    metadata.add('managed-orphan')
    await expect(sync.sync(input(1, '["managed-a"]'))).resolves.toMatchObject({ reconciled: true })
    expect([...installed].sort()).toEqual(['managed-a', 'managed-bare', 'personal'])
    expect(deps.remove).toHaveBeenCalledWith('claude', ['managed-orphan'])
  })

  it('keeps managed slots another scope, principal or older identity form still desires', async () => {
    const { sync, input, installed, metadata, deps } = managedSetup()
    const machine = { version: 1 as const, scope: 'company', principalType: 'machine' as const, machineId: 'machine-1', provider: 'claude' as const, generation: 1, fingerprint: 'c'.repeat(64), payload: '["managed-m"]' }
    await sync.sync(machine)
    await sync.sync(input(1, '["managed-o"]', 'other'))
    // An entry of an older daemon that still names a slot by its older identity form.
    const journal = JSON.parse((await deps.read())!)
    journal.entries.push({ scope: 'legacy', principalType: 'user', userId: 'user', provider: 'claude', generation: 1, fingerprint: 'd'.repeat(64), payloadDigest: null, desired: ['legacy-hash-l'], owned: [], pending: false })
    await deps.write(JSON.stringify(journal))
    installed.add('managed-l'); metadata.add('managed-l')
    deps.managedInstalled.mockImplementation(async () => [...installed].filter(id => metadata.has(id)).map(identity => ({ identity, aliases: identity === 'managed-l' ? ['legacy-hash-l'] : [] })))
    await sync.sync(input(1, '["managed-a"]'))
    expect([...installed].sort()).toEqual(['managed-a', 'managed-l', 'managed-m', 'managed-o', 'personal'])
  })

  it('does not sweep after an assignment without setup-tokens', async () => {
    const { sync, input, installed, metadata, deps } = managedSetup()
    installed.add('managed-orphan'); metadata.add('managed-orphan')
    await sync.sync(input(1, '["shared"]'))
    expect(installed.has('managed-orphan')).toBe(true)
    expect(deps.managedInstalled).not.toHaveBeenCalled()
  })

  it('defers removing a slot a running session is bound to, without failing the receipt, and removes it on a later sync', async () => {
    const busy = new Set(['managed-a', 'managed-orphan'])
    const inUse = vi.fn(async () => [...busy])
    const { sync, input, installed, metadata, deps } = managedSetup({ inUse })
    installed.add('managed-orphan'); metadata.add('managed-orphan')
    await sync.sync(input(1, '["managed-a"]'))
    await expect(sync.sync(input(2, '["managed-b"]'))).resolves.toMatchObject({ reconciled: true })
    expect([...installed].sort()).toEqual(['managed-a', 'managed-b', 'managed-orphan', 'personal'])
    expect(inUse).toHaveBeenCalledWith('claude')
    busy.clear()
    // The same assignment again (a Desktop retry): the deferred removals happen now.
    await expect(sync.sync(input(2, '["managed-b"]'))).resolves.toMatchObject({ reconciled: true })
    expect([...installed].sort()).toEqual(['managed-b', 'personal'])
    expect(deps.apply).toHaveBeenCalledTimes(2)
  })

  it('does not acknowledge an orphan that could not be removed', async () => {
    const { sync, input, installed, metadata, deps } = managedSetup()
    installed.add('managed-orphan'); metadata.add('managed-orphan')
    deps.remove.mockResolvedValue(undefined)
    await expect(sync.sync(input(1, '["managed-a"]'))).rejects.toThrow('AI_GROUP_REMOVAL_INCOMPLETE')
    expect(await sync.receipt('company', 'claude')).toMatchObject({ reconciled: false })
  })
})
