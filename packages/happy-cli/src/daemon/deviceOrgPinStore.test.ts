import { mkdtemp, rm, readFile, writeFile, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { signOrgSetupTokenDocument, orgSetupTokenKeyId } from '@slopus/happy-wire';
import { loadOrCreateDeviceKeys } from './deviceKeys';
import { createDeviceOrgPinStore } from './deviceOrgPinStore';
vi.mock('node:fs/promises',async(importOriginal)=>{const actual=await importOriginal<typeof import('node:fs/promises')>();return {...actual,link:vi.fn(actual.link)};});
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, {recursive:true,force:true}))); });
async function fixture() {
 const home = await mkdtemp(join(tmpdir(),'device-pin-')); homes.push(home);
 const keys = await loadOrCreateDeviceKeys(home,'machine');
 const signer = nacl.sign.keyPair();
 const publicKey = Buffer.from(signer.publicKey).toString('base64url');
 const approval = await signOrgSetupTokenDocument({version:1,kind:'device-approval',companyId:'company',machineId:'machine',machineType:'dedicated',ownerUserId:'user',signingGeneration:1,signingKeyId:await orgSetupTokenKeyId(signer.publicKey),issuedAt:1000,approvalId:'approval',approvalRevision:1,deviceSigningPublicKey:Buffer.from(keys.signing.publicKey).toString('base64url'),recipientPublicKey:Buffer.from(keys.recipient.publicKey).toString('base64url'),enrollmentDigest:'a'.repeat(64)},signer.secretKey);
 const deps={home,machineId:'machine',keys};
 const path=join(home,'device-'+createHash('sha256').update('machine').digest('hex'),'org-'+createHash('sha256').update('company').digest('hex')+'.json');
 return {signer,deps,store:createDeviceOrgPinStore(deps),candidate:{publicKey,approval},path};
}
it('persists pin and signed-required policy together and reloads after restart',async()=>{
 const f=await fixture();expect(await f.store.get('company')).toBeNull();
 await f.store.pin(f.candidate);
 expect(await createDeviceOrgPinStore(f.deps).get('company')).toMatchObject({...f.candidate,policy:'signed-required'});
 expect(JSON.parse(await readFile(f.path,'utf8')).policy).toBe('signed-required');
});
it('allows concurrent identical retries but refuses replacement and preserves the original pin',async()=>{
 const f=await fixture();await Promise.all([f.store.pin(f.candidate),createDeviceOrgPinStore(f.deps).pin(f.candidate)]);
 await expect(f.store.pin({...f.candidate,publicKey:Buffer.from(nacl.sign.keyPair().publicKey).toString('base64url')})).rejects.toThrow();
 expect(await f.store.get('company')).toMatchObject(f.candidate);
});
it('fails closed for corrupted storage instead of returning no policy',async()=>{
 const f=await fixture();await f.store.pin(f.candidate);await writeFile(f.path,'{}');
 await expect(createDeviceOrgPinStore(f.deps).get('company')).rejects.toThrow();
 await expect(f.store.pin(f.candidate)).rejects.toThrow();
});
it('rejects stored approval belonging to different local device keys',async()=>{
 const f=await fixture();await f.store.pin(f.candidate);
 const changed={...f.deps,keys:{signing:nacl.sign.keyPair(),recipient:nacl.box.keyPair()}};
 await expect(createDeviceOrgPinStore(changed).get('company')).rejects.toThrow();
});

it('preserves the first valid pin when another valid signed approval races it',async()=>{
 const f=await fixture();const other={...f.candidate,approval:await signOrgSetupTokenDocument({...f.candidate.approval.body,approvalId:'other'},f.signer.secretKey)};
 const result=await Promise.allSettled([f.store.pin(f.candidate),createDeviceOrgPinStore(f.deps).pin(other)]);
 expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(result.filter(r=>r.status==='rejected')).toHaveLength(1);
 const stored=await f.store.get('company');expect(['approval','other']).toContain(stored?.approval.body.kind==='device-approval' ? stored.approval.body.approvalId : 'invalid');
});
it('does not publish partial policy on a failed filesystem write and permits retry',async()=>{
 const f=await fixture();vi.mocked(link).mockRejectedValueOnce(new Error('disk failure'));
 await expect(f.store.pin(f.candidate)).rejects.toThrow('disk failure');expect(await f.store.get('company')).toBeNull();
 await f.store.pin(f.candidate);expect(await f.store.get('company')).toMatchObject({policy:'signed-required'});
});
it('rejects symlinked pin files rather than following them',async()=>{
 const f=await fixture();const target=join(f.deps.home,'external.json');await writeFile(target,'{}');await symlink(target,f.path);
 await expect(f.store.get('company')).rejects.toThrow();
 await expect(f.store.pin(f.candidate)).rejects.toThrow();
});
