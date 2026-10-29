/* Administrator-only policy primitive. Persistent filters outlive this process.
 * No DNS-isolation or complete browser readiness claim is made by this helper. */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <fwpmu.h>
#include <sddl.h>
#include <stdio.h>
#include <wchar.h>
#include <string.h>
#include <stdlib.h>

static const GUID layer_key = {0x04aa6ff6,0x7872,0x4e02,{0xa2,0x84,0x7b,0xb5,0xda,0x30,0x02,0x00}};
static GUID filter_key(unsigned index) { GUID key = layer_key; key.Data4[7] = (BYTE)(index + 1); return key; }
static int administrator(void) {
    SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY;
    PSID sid = NULL; BOOL member = FALSE;
    if (!AllocateAndInitializeSid(&authority, 2, SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS, 0,0,0,0,0,0,&sid)) return 0;
    if (!CheckTokenMembership(NULL,sid,&member)) member = FALSE;
    FreeSid(sid); return member != FALSE;
}
static int same_condition(const FWPM_FILTER_CONDITION0 *a, const FWPM_FILTER_CONDITION0 *b) {
    if (!IsEqualGUID(&a->fieldKey,&b->fieldKey) || a->matchType != b->matchType || a->conditionValue.type != b->conditionValue.type) return 0;
    switch (a->conditionValue.type) {
        case FWP_UINT8: return a->conditionValue.uint8 == b->conditionValue.uint8;
        case FWP_UINT16: return a->conditionValue.uint16 == b->conditionValue.uint16;
        case FWP_UINT32: return a->conditionValue.uint32 == b->conditionValue.uint32;
        case FWP_SECURITY_DESCRIPTOR_TYPE: {
            FWP_BYTE_BLOB *x=a->conditionValue.sd,*y=b->conditionValue.sd;
            return x && y && x->size == y->size && memcmp(x->data,y->data,x->size)==0;
        }
        default: return 0;
    }
}
static void expected_filter(unsigned index, FWPM_FILTER0 *filter, FWPM_FILTER_CONDITION0 conditions[2], FWP_BYTE_BLOB *identity, UINT16 port) {
    memset(filter,0,sizeof(*filter)); memset(conditions,0,2*sizeof(*conditions));
    filter->filterKey = filter_key(index); filter->subLayerKey = layer_key;
    filter->layerKey = index < 3 ? FWPM_LAYER_ALE_AUTH_CONNECT_V4 : index == 3 ? FWPM_LAYER_ALE_AUTH_CONNECT_V6 : index == 4 ? FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4 : FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6;
    filter->displayData.name = L"Saycode browser SID egress fence";
    filter->flags = FWPM_FILTER_FLAG_PERSISTENT;
    filter->action.type = FWP_ACTION_BLOCK;
    filter->weight.type = FWP_UINT8; filter->weight.uint8 = 15;
    filter->filterCondition = conditions; filter->numFilterConditions = index < 3 ? 2 : 1;
    conditions[0].fieldKey = FWPM_CONDITION_ALE_USER_ID;
    conditions[0].matchType = FWP_MATCH_EQUAL;
    conditions[0].conditionValue.type = FWP_SECURITY_DESCRIPTOR_TYPE; conditions[0].conditionValue.sd = identity;
    conditions[1].matchType = FWP_MATCH_NOT_EQUAL;
    if (index == 0) {
        conditions[1].fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
        conditions[1].conditionValue.type = FWP_UINT32; conditions[1].conditionValue.uint32 = 0x7f000001;
    } else if (index == 1) {
        conditions[1].fieldKey = FWPM_CONDITION_IP_PROTOCOL;
        conditions[1].conditionValue.type = FWP_UINT8; conditions[1].conditionValue.uint8 = IPPROTO_TCP;
    } else {
        conditions[1].fieldKey = FWPM_CONDITION_IP_REMOTE_PORT;
        conditions[1].conditionValue.type = FWP_UINT16; conditions[1].conditionValue.uint16 = port;
    }
}
static DWORD verify_filter_inventory(HANDLE engine) {
    HANDLE enumerator=NULL;
    DWORD status=FwpmFilterCreateEnumHandle0(engine,NULL,&enumerator);
    if(status!=ERROR_SUCCESS) return status;
    unsigned count=0;
    for (;;) {
        FWPM_FILTER0 **filters=NULL; UINT32 returned=0;
        status=FwpmFilterEnum0(engine,enumerator,256,&filters,&returned);
        if(status!=ERROR_SUCCESS) break;
        for(UINT32 i=0;i<returned;++i) if(IsEqualGUID(&filters[i]->subLayerKey,&layer_key)) {
            int expected=0; ++count;
            for(unsigned j=0;j<6;++j) { GUID key=filter_key(j); if(IsEqualGUID(&filters[i]->filterKey,&key)) expected=1; }
            if(!expected) status=ERROR_INVALID_DATA;
        }
        if(filters) FwpmFreeMemory0((void**)&filters);
        if(status!=ERROR_SUCCESS || returned==0) break;
    }
    FwpmFilterDestroyEnumHandle0(engine,enumerator);
    return status==ERROR_SUCCESS && count!=6 ? ERROR_INVALID_DATA : status;
}
static DWORD verify(HANDLE engine, FWP_BYTE_BLOB *identity, UINT16 port) {
    FWPM_SUBLAYER0 *sublayer = NULL;
    DWORD status = FwpmSubLayerGetByKey0(engine,&layer_key,&sublayer);
    if (status != ERROR_SUCCESS) return status;
    /* BFE can raise a colliding requested sublayer weight. Never accept a lower priority. */
    int valid = sublayer->flags == FWPM_SUBLAYER_FLAG_PERSISTENT && sublayer->weight >= 0x9000;
    FwpmFreeMemory0((void**)&sublayer);
    if (!valid) return ERROR_INVALID_DATA;
    for (unsigned index=0;index<6;++index) {
        FWPM_FILTER0 expected,*actual=NULL; FWPM_FILTER_CONDITION0 conditions[2];
        expected_filter(index,&expected,conditions,identity,port);
        status = FwpmFilterGetByKey0(engine,&expected.filterKey,&actual);
        if (status != ERROR_SUCCESS) return status;
        valid = actual->flags == expected.flags && actual->action.type == expected.action.type &&
            IsEqualGUID(&actual->layerKey,&expected.layerKey) && IsEqualGUID(&actual->subLayerKey,&expected.subLayerKey) &&
            actual->weight.type == FWP_UINT8 && actual->weight.uint8 == 15 && actual->numFilterConditions == expected.numFilterConditions;
        if (valid) for (UINT32 i=0;i<expected.numFilterConditions;++i) {
            int found=0;
            for (UINT32 j=0;j<actual->numFilterConditions;++j) if (same_condition(&conditions[i],&actual->filterCondition[j])) found=1;
            if (!found) valid=0;
        }
        FwpmFreeMemory0((void**)&actual);
        if (!valid) return ERROR_INVALID_DATA;
    }
    // An extra higher-weight permit in our sublayer could defeat otherwise intact blocks.
    return verify_filter_inventory(engine);
}
int wmain(int argc, wchar_t **argv) {
    if (argc != 4 || !administrator()) return 2;
    int install = wcscmp(argv[1],L"install")==0, remove = wcscmp(argv[1],L"remove")==0;
    if (!install && !remove && wcscmp(argv[1],L"verify")!=0) return 2;
    // Only dedicated virtual service identities; never fence the logged-in user.
    if (wcsncmp(argv[2],L"S-1-5-80-",9)!=0 || wcslen(argv[2])>184) return 2;
    PSID sid=NULL;
    if (!ConvertStringSidToSidW(argv[2],&sid)) return 2;
    LocalFree(sid);
    wchar_t *end=NULL; unsigned long number=wcstoul(argv[3],&end,10);
    if (!end || *end || number<1024 || number>65535) return 2;
    wchar_t sddl[256];
    if (swprintf_s(sddl,256,L"D:(A;;CC;;;%ls)",argv[2])<0) return 2;
    PSECURITY_DESCRIPTOR descriptor=NULL; ULONG length=0;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,SDDL_REVISION_1,&descriptor,&length)) return 2;
    FWP_BYTE_BLOB identity={length,(UINT8*)descriptor}; HANDLE engine=NULL;
    DWORD status=FwpmEngineOpen0(NULL,RPC_C_AUTHN_WINNT,NULL,NULL,&engine);
    if (status==ERROR_SUCCESS && (install || remove)) {
        status=FwpmTransactionBegin0(engine,0);
        if (status==ERROR_SUCCESS) {
            if (install) {
                FWPM_SUBLAYER0 sublayer; memset(&sublayer,0,sizeof(sublayer));
                sublayer.subLayerKey=layer_key; sublayer.displayData.name=L"Saycode browser SID fence";
                sublayer.flags=FWPM_SUBLAYER_FLAG_PERSISTENT; sublayer.weight=0x9000;
                status=FwpmSubLayerAdd0(engine,&sublayer,NULL);
                for(unsigned i=0;status==ERROR_SUCCESS && i<6;++i) {
                    FWPM_FILTER0 filter; FWPM_FILTER_CONDITION0 conditions[2];
                    expected_filter(i,&filter,conditions,&identity,(UINT16)number);
                    status=FwpmFilterAdd0(engine,&filter,NULL,NULL);
                }
            } else {
                // Refuse to remove a policy belonging to another SID/port or an unknown version.
                status=verify(engine,&identity,(UINT16)number);
                for(unsigned i=0;status==ERROR_SUCCESS && i<6;++i) { GUID key=filter_key(i); status=FwpmFilterDeleteByKey0(engine,&key); }
                if(status==ERROR_SUCCESS) status=FwpmSubLayerDeleteByKey0(engine,&layer_key);
            }
            if(status==ERROR_SUCCESS && install) status=verify(engine,&identity,(UINT16)number);
            if(status==ERROR_SUCCESS) status=FwpmTransactionCommit0(engine);
            else FwpmTransactionAbort0(engine);
        }
    }
    if(status==ERROR_SUCCESS && !remove) status=verify(engine,&identity,(UINT16)number);
    if(engine) FwpmEngineClose0(engine);
    LocalFree(descriptor);
    if(status!=ERROR_SUCCESS) { fprintf(stderr,"BROWSER_FENCE_ERROR:%lu\n",(unsigned long)status); return 1; }
    puts(remove ? "removed" : "verified"); return 0;
}
