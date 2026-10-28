/* Node-API keeps the lock in the runtime process, not a helper that can die first.
 * No credentials, paths or browser operations cross this small native boundary. */
#include <node_api.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <limits.h>
#ifdef _WIN32
/* Resolve Node's descriptors through Node/libuv's CRT, not this addon's CRT.
 * _get_osfhandle can fast-fail the process even for a valid Node descriptor. */
#include <uv.h>
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <io.h>
#else
#include <errno.h>
#include <unistd.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <sys/sysctl.h>
#include <libproc.h>
#endif

static napi_value error(napi_env env, const char *code) {
    napi_throw_error(env, code, code);
    return NULL;
}

static int argument(napi_env env, napi_callback_info info, int minimum, int *out) {
    size_t count = 2;
    napi_value args[2];
    double number;
    if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
        napi_get_value_double(env, args[0], &number) != napi_ok ||
        !(number >= minimum && number <= INT_MAX) || number != (int)number) {
        error(env, "NATIVE_INVALID_ARGUMENT"); return 0;
    }
    *out = (int)number; return 1;
}

static napi_value text(napi_env env, const char *value) {
    napi_value result;
    if (napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result) != napi_ok)
        return error(env, "NATIVE_RESULT_FAILED");
    return result;
}

static napi_value missing(napi_env env) {
    napi_value result; napi_get_null(env, &result); return result;
}

static napi_value lock_writer(napi_env env, napi_callback_info info) {
    int fd;
    if (!argument(env, info, 0, &fd)) return NULL;
#ifdef _WIN32
    HANDLE handle = (HANDLE)uv_get_osfhandle(fd);
    BY_HANDLE_FILE_INFORMATION metadata;
    if (handle == INVALID_HANDLE_VALUE || GetFileType(handle) != FILE_TYPE_DISK ||
        !GetFileInformationByHandle(handle, &metadata) ||
        (metadata.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) || metadata.nNumberOfLinks != 1)
        return error(env, "NATIVE_LOCK_UNSAFE");
    OVERLAPPED offset;
    memset(&offset, 0, sizeof(offset));
    if (!LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, MAXDWORD, MAXDWORD, &offset))
        return error(env, GetLastError() == ERROR_LOCK_VIOLATION ? "NATIVE_LOCK_BUSY" : "NATIVE_LOCK_FAILED");
#else
    struct stat metadata;
    if (fstat(fd, &metadata) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_uid != geteuid() ||
        (metadata.st_mode & (S_IWGRP | S_IWOTH)) || metadata.st_nlink != 1)
        return error(env, "NATIVE_LOCK_UNSAFE");
    if (flock(fd, LOCK_EX | LOCK_NB) != 0)
        return error(env, (errno == EWOULDBLOCK || errno == EAGAIN) ? "NATIVE_LOCK_BUSY" : "NATIVE_LOCK_FAILED");
#endif
    napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value process_start(napi_env env, napi_callback_info info) {
    int pid;
    if (!argument(env, info, 1, &pid)) return NULL;
    uint64_t started;
#ifdef _WIN32
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, (DWORD)pid);
    if (process == NULL) {
        if (GetLastError() == ERROR_INVALID_PARAMETER) return missing(env);
        return error(env, "NATIVE_PROCESS_UNKNOWN");
    }
    DWORD wait = WaitForSingleObject(process, 0);
    if (wait == WAIT_OBJECT_0) { CloseHandle(process); return missing(env); }
    FILETIME creation, exit, kernel, user;
    if (wait != WAIT_TIMEOUT || !GetProcessTimes(process, &creation, &exit, &kernel, &user)) {
        CloseHandle(process); return error(env, "NATIVE_PROCESS_UNKNOWN");
    }
    started = ((uint64_t)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
    CloseHandle(process);
#else
    struct proc_bsdinfo process;
    memset(&process, 0, sizeof(process));
    errno = 0;
    int length = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &process, sizeof(process));
    if (length != sizeof(process)) {
        if (errno == ESRCH) return missing(env);
        return error(env, "NATIVE_PROCESS_UNKNOWN");
    }
    if (process.pbi_pid != (uint32_t)pid) return error(env, "NATIVE_PROCESS_UNKNOWN");
    started = (uint64_t)process.pbi_start_tvsec * 1000000 + process.pbi_start_tvusec;
#endif
    if (started == 0) return error(env, "NATIVE_PROCESS_UNKNOWN");
    char value[32]; snprintf(value, sizeof(value), "%llu", (unsigned long long)started);
    return text(env, value);
}

/* A protected Mac service binary and each ancestor are root owned and cannot
 * carry ACL grants hidden by the POSIX mode bits. Read only, never fixes modes. */
static napi_value verify_root_owned(napi_env env, napi_callback_info info) {
    int fd;
    if (!argument(env, info, 0, &fd)) return NULL;
#ifdef _WIN32
    (void)fd;
    return error(env, "NATIVE_PATH_VERIFIER_UNSUPPORTED");
#else
    struct stat metadata;
    filesec_t security = filesec_init();
    if (!security) return error(env, "NATIVE_PATH_UNTRUSTED");
    int observed = fstatx_np(fd, &metadata, security);
    int acl_present = -1;
    int queried = filesec_query_property(security, FILESEC_ACL, &acl_present);
    filesec_free(security);
    /* An explicit successful query is required: acl_get_fd_np returns ENOENT
     * for no ACL, which must not be confused with a metadata access failure. */
    if (observed != 0 || queried != 0 || acl_present != 0 || metadata.st_uid != 0 ||
        (metadata.st_mode & (S_IWGRP | S_IWOTH)) ||
        (!S_ISREG(metadata.st_mode) && !S_ISDIR(metadata.st_mode)) ||
        (S_ISREG(metadata.st_mode) && metadata.st_nlink != 1))
        return error(env, "NATIVE_PATH_UNTRUSTED");
    napi_value result; napi_get_undefined(env, &result); return result;
#endif
}

static napi_value process_principal(napi_env env, napi_callback_info info) {
    int pid;
    if (!argument(env, info, 1, &pid)) return NULL;
#ifdef _WIN32
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, (DWORD)pid);
    if (!process) {
        if (GetLastError() == ERROR_INVALID_PARAMETER) return missing(env);
        return error(env, "NATIVE_PROCESS_UNKNOWN");
    }
    DWORD wait = WaitForSingleObject(process, 0);
    if (wait == WAIT_OBJECT_0) { CloseHandle(process); return missing(env); }
    HANDLE token = NULL;
    if (wait != WAIT_TIMEOUT || !OpenProcessToken(process, TOKEN_QUERY, &token)) {
        CloseHandle(process); return error(env, "NATIVE_PROCESS_UNKNOWN");
    }
    DWORD bytes = 0;
    GetTokenInformation(token, TokenUser, NULL, 0, &bytes);
    if (!bytes || bytes > 65536 || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
        CloseHandle(token); CloseHandle(process); return error(env, "NATIVE_PROCESS_UNKNOWN");
    }
    TOKEN_USER *user = (TOKEN_USER *)LocalAlloc(LMEM_FIXED, bytes);
    LPSTR sid = NULL;
    BOOL valid = user && GetTokenInformation(token, TokenUser, user, bytes, &bytes) &&
        IsValidSid(user->User.Sid) && ConvertSidToStringSidA(user->User.Sid, &sid) &&
        WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
    napi_value result = valid ? text(env, sid) : error(env, "NATIVE_PROCESS_UNKNOWN");
    if (sid) LocalFree(sid);
    if (user) LocalFree(user);
    CloseHandle(token); CloseHandle(process);
    return result;
#else
    struct proc_bsdinfo process;
    memset(&process, 0, sizeof(process));
    errno = 0;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &process, sizeof(process)) != sizeof(process)) {
        if (errno == ESRCH) return missing(env);
        return error(env, "NATIVE_PROCESS_UNKNOWN");
    }
    if (process.pbi_pid != (uint32_t)pid) return error(env, "NATIVE_PROCESS_UNKNOWN");
    char value[32]; snprintf(value, sizeof(value), "%u", process.pbi_uid);
    return text(env, value);
#endif
}

#ifdef _WIN32
static int service_trustee(PSID sid, PSID service) {
    return IsValidSid(sid) && (EqualSid(sid, service) || IsWellKnownSid(sid, WinLocalSystemSid) ||
        IsWellKnownSid(sid, WinBuiltinAdministratorsSid));
}
#endif

/* Windows ACLs are read from the opened handle, never a second path lookup.
 * Expected service SID comes from protected installation state, not an RPC field. */
static napi_value verify_service_file(napi_env env, napi_callback_info info) {
#ifdef _WIN32
    size_t count = 4, length = 0;
    napi_value args[4];
    double number;
    bool private_file;
    char sid_text[257];
    if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 3 ||
        napi_get_value_double(env, args[0], &number) != napi_ok || !(number >= 0 && number <= INT_MAX) || number != (int)number ||
        napi_get_value_string_utf8(env, args[1], NULL, 0, &length) != napi_ok || length == 0 || length >= sizeof(sid_text) ||
        napi_get_value_string_utf8(env, args[1], sid_text, sizeof(sid_text), &length) != napi_ok ||
        napi_get_value_bool(env, args[2], &private_file) != napi_ok || strlen(sid_text) != length)
        return error(env, "NATIVE_INVALID_ARGUMENT");
    HANDLE handle = (HANDLE)uv_get_osfhandle((int)number);
    BY_HANDLE_FILE_INFORMATION metadata;
    if (handle == INVALID_HANDLE_VALUE || GetFileType(handle) != FILE_TYPE_DISK ||
        !GetFileInformationByHandle(handle, &metadata) || (metadata.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        (!(metadata.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && metadata.nNumberOfLinks != 1))
        return error(env, "NATIVE_PATH_UNTRUSTED");
    PSID service = NULL, owner = NULL;
    PACL acl = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    if ((strncmp(sid_text, "S-1-5-21-", 9) != 0 && strncmp(sid_text, "S-1-5-80-", 9) != 0) ||
        !ConvertStringSidToSidA(sid_text, &service)) return error(env, "NATIVE_INVALID_ARGUMENT");
    DWORD status = GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &owner, NULL, &acl, NULL, &descriptor);
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    int safe = status == ERROR_SUCCESS && owner && service_trustee(owner, service) && acl && IsValidAcl(acl) &&
        GetSecurityDescriptorControl(descriptor, &control, &revision) && (!private_file || (control & SE_DACL_PROTECTED));
    const ACCESS_MASK writes = GENERIC_ALL | GENERIC_WRITE | WRITE_DAC | WRITE_OWNER | DELETE |
        FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | FILE_DELETE_CHILD;
    if (safe) for (DWORD index = 0; index < acl->AceCount; ++index) {
        void *raw = NULL;
        if (!GetAce(acl, index, &raw)) { safe = 0; break; }
        ACE_HEADER *header = (ACE_HEADER *)raw;
        if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
        if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) { safe = 0; break; }
        ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)raw;
        PSID trustee = (PSID)&ace->SidStart;
        if (!IsValidSid(trustee) || (!service_trustee(trustee, service) && (private_file || (ace->Mask & writes)))) {
            safe = 0; break;
        }
    }
    if (descriptor) LocalFree(descriptor);
    LocalFree(service);
    if (!safe) return error(env, "NATIVE_PATH_UNTRUSTED");
    napi_value result; napi_get_undefined(env, &result); return result;
#else
    (void)info;
    return error(env, "NATIVE_PATH_VERIFIER_UNSUPPORTED");
#endif
}

static napi_value boot_id(napi_env env, napi_callback_info info) {
    (void)info;
    char value[80];
#ifdef _WIN32
    /* The kernel boot GUID is stable within a boot; wall-clock-derived estimates
     * are not identities and would revoke live registrations after clock changes. */
    typedef LONG (WINAPI *QuerySystem)(ULONG, PVOID, ULONG, PULONG);
    typedef struct { GUID identifier; ULONG firmwareType; ULONGLONG flags; } BootInfo;
    HMODULE module = GetModuleHandleW(L"ntdll.dll");
    QuerySystem query = module ? (QuerySystem)GetProcAddress(module, "NtQuerySystemInformation") : NULL;
    BootInfo boot;
    memset(&boot, 0, sizeof(boot));
    ULONG returned = 0;
    if (!query || query(90, &boot, sizeof(boot), &returned) < 0 || returned < sizeof(GUID))
        return error(env, "NATIVE_BOOT_UNKNOWN");
    GUID g = boot.identifier;
    if (!(g.Data1 || g.Data2 || g.Data3 || g.Data4[0] || g.Data4[1] || g.Data4[2] || g.Data4[3] || g.Data4[4] || g.Data4[5] || g.Data4[6] || g.Data4[7]))
        return error(env, "NATIVE_BOOT_UNKNOWN");
    snprintf(value, sizeof(value), "%08lx-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        (unsigned long)g.Data1, g.Data2, g.Data3, g.Data4[0], g.Data4[1], g.Data4[2], g.Data4[3], g.Data4[4], g.Data4[5], g.Data4[6], g.Data4[7]);
#else
    size_t length = sizeof(value);
    if (sysctlbyname("kern.bootsessionuuid", value, &length, NULL, 0) != 0)
        return error(env, errno == EPERM || errno == EACCES ? "NATIVE_BOOT_ACCESS_DENIED" : "NATIVE_BOOT_UNKNOWN");
    if (length < 2 || length >= sizeof(value)) return error(env, "NATIVE_BOOT_UNKNOWN");
    value[length] = '\0';
#endif
    return text(env, value);
}

static napi_value initialize(napi_env env, napi_value exports) {
    napi_property_descriptor properties[] = {
        {"lockWriter", NULL, lock_writer, NULL, NULL, NULL, napi_default, NULL},
        {"processStart", NULL, process_start, NULL, NULL, NULL, napi_default, NULL},
        {"bootId", NULL, boot_id, NULL, NULL, NULL, napi_default, NULL},
        {"verifyRootOwned", NULL, verify_root_owned, NULL, NULL, NULL, napi_default, NULL},
        {"processPrincipal", NULL, process_principal, NULL, NULL, NULL, napi_default, NULL},
        {"verifyServiceFile", NULL, verify_service_file, NULL, NULL, NULL, napi_default, NULL},
    };
    if (napi_define_properties(env, exports, 6, properties) != napi_ok) return error(env, "NATIVE_INIT_FAILED");
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
