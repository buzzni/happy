/** Per-binding immutable credential snapshot, separate from legacy endpoint generation cache. */
import { parseOrgLlmEndpointSync, OrgLlmEndpointError, type OrgLlmEndpointEntry } from './orgLlmEndpoint'
import { isOrgEndpointId } from './sessionEnv'
export type OrgLlmModelBinding = {maxOutputTokens:number;version:1;bindingId:string;snapshotId:string;selectedModel:string;launchSecret:string;machineId:string;entry:OrgLlmEndpointEntry}
export function parseOrgLlmModelBinding(value: unknown): OrgLlmModelBinding {
    const fail=():never=>{throw new OrgLlmEndpointError('ORG_LLM_ENDPOINT_PAYLOAD_INVALID')}
    if(!value || typeof value!=='object' || Array.isArray(value)) return fail()
    const v=value as Record<string,unknown>
    if(Object.keys(v).some(k=>!['version','bindingId','snapshotId','selectedModel','launchSecret','machineId','companyId','userId','endpoint','maxOutputTokens'].includes(k))) return fail()
    if(v.version!==1 || !isOrgEndpointId(v.bindingId) || !isOrgEndpointId(v.snapshotId) || !isOrgEndpointId(v.machineId) || typeof v.launchSecret!=='string' || !/^[a-zA-Z0-9]{64}$/.test(v.launchSecret)) return fail()
    if(typeof v.maxOutputTokens!=='number' || !Number.isSafeInteger(v.maxOutputTokens) || v.maxOutputTokens<1024 || v.maxOutputTokens>65536) return fail()
    const entry=parseOrgLlmEndpointSync({version:1,companyId:v.companyId,userId:v.userId,endpoint:v.endpoint})
    if(v.selectedModel!==entry.model || entry.authMode!=='static-token' || Object.keys(entry.models).length || entry.targets.length!==1 || entry.targets[0]!.url!=='https://apis.opengateway.ai') return fail()
    return {maxOutputTokens:v.maxOutputTokens,version:1,bindingId:v.bindingId,snapshotId:v.snapshotId,selectedModel:entry.model,launchSecret:v.launchSecret,machineId:v.machineId,entry}
}
