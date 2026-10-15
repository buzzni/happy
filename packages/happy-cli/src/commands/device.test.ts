import { expect, it, vi } from 'vitest';
import { handleDeviceCommand } from './device';
const digest='abcdef0123456789'.repeat(4);
function fixture(){return {status:vi.fn(async()=>({machineId:'machine',companyId:'company',enrollment:{digest,expiresAt:1000,locallyConfirmed:false,administratorApproved:false},pin:null})),confirm:vi.fn(async()=>({locallyConfirmed:true})),print:vi.fn()};}
it('shows the entire grouped fingerprint and distinguishes administrator and local waiting states',async()=>{
 const deps=fixture();await handleDeviceCommand(['status','--company-id','company'],deps);
 expect(deps.status).toHaveBeenCalledWith('company');
 const output=deps.print.mock.calls.flat().join('\n');
 expect(output).toContain(digest.match(/.{4}/g)!.join(' '));
 expect(output).toContain('machine');expect(output).toContain('company');
 expect(output).toContain('관리자 승인 대기');expect(output).toContain('로컬 확인 대기');
 expect(deps.confirm).not.toHaveBeenCalled();
});
it('requires explicit organization, machine and full fingerprint before local confirmation',async()=>{
 const deps=fixture();
 for(const args of [[],['confirm'],['confirm','--company-id','company','--machine-id','machine','--digest','abcdef'],['confirm','--company-id','company','--machine-id','machine','--digest',digest,'--remote','host']]) await expect(handleDeviceCommand(args,deps)).rejects.toThrow();
 expect(deps.confirm).not.toHaveBeenCalled();
 await handleDeviceCommand(['confirm','--company-id','company','--machine-id','machine','--digest',digest],deps);
 expect(deps.confirm).toHaveBeenCalledWith({companyId:'company',machineId:'machine',enrollmentDigest:digest});
 expect(deps.status).not.toHaveBeenCalled();
 expect(deps.print).toHaveBeenCalledWith(expect.stringContaining('로컬 확인이 완료되었습니다'));
});
it('does not print confirmation success or raw transport secrets on failure',async()=>{
 const deps=fixture();deps.confirm.mockRejectedValueOnce(new Error('private-control-secret'));
 await expect(handleDeviceCommand(['confirm','--company-id','company','--machine-id','machine','--digest',digest],deps)).rejects.toThrow('DEVICE_CONTROL_UNAVAILABLE');
 expect(deps.print).not.toHaveBeenCalled();
});
