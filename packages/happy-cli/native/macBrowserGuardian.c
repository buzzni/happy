// Root-launched, never setuid. Owns one original process group until it is drained.
// stdin carries lifetime/identity challenges; stdout receipts never carry commands. fd 3/4 are CDP.
// No paths, commands or policy are accepted after launch.
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/acl.h>
#include <sys/proc.h>
#include <libproc.h>
#include <poll.h>
#include <signal.h>
#include <grp.h>
#include <pwd.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// A root-only crash latch is created durably before fork. No automatic restart
// may erase it after owner loss, including a SIGKILL that skips all cleanup.
static int recovery_dir = -1, recovery_lock = -1;
static int no_acl(int fd) {
    struct stat info;
    filesec_t security = filesec_init();
    if (!security) return 0;
    int observed = fstatx_np(fd, &info, security), present = -1;
    int queried = filesec_query_property(security, FILESEC_ACL, &present);
    filesec_free(security);
    return observed == 0 && queried == 0 && present == 0;
}
static int open_recovery(const char *path) {
    if (path[0] != '/' || strlen(path) >= PATH_MAX || strstr(path, "//")) return -1;
    char copy[PATH_MAX]; strcpy(copy, path + 1);
    int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    char *save = NULL;
    for (char *part = strtok_r(copy, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
        if (!strcmp(part, ".") || !strcmp(part, "..")) { close(fd); return -1; }
        int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        close(fd); fd = next;
        struct stat info;
        if (fd < 0 || fstat(fd, &info) || info.st_uid != 0 || !no_acl(fd) ||
            ((info.st_mode & 0022) && !(info.st_mode & S_ISVTX))) { if (fd >= 0) close(fd); return -1; }
    }
    struct stat info;
    if (fstat(fd, &info) || (info.st_mode & 07777) != 0700) { close(fd); return -1; }
    return fd;
}
static int lock_recovery(const char *path) {
    recovery_dir = open_recovery(path);
    if (recovery_dir < 0) return -1;
    recovery_lock = openat(recovery_dir, "owner.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
    struct stat info;
    if (recovery_lock < 0 || fstat(recovery_lock, &info) || !S_ISREG(info.st_mode) || info.st_uid != 0 ||
        info.st_nlink != 1 || (info.st_mode & 07777) != 0600 || !no_acl(recovery_lock) || flock(recovery_lock, LOCK_EX | LOCK_NB)) return -1;
    return 0;
}
static int begin_recovery(const char *path, unsigned uid) {
    if (lock_recovery(path)) return -1;
    int active = openat(recovery_dir, "active", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (active < 0) return -1;
    char receipt[80]; int length = snprintf(receipt, sizeof(receipt), "v1 uid=%u guardian=%d\n", uid, getpid());
    int result = write(active, receipt, (size_t)length) == length && fsync(active) == 0 && fsync(recovery_dir) == 0 ? 0 : -1;
    close(active);
    return result;
}
static int complete_recovery(void) {
    return unlinkat(recovery_dir, "active", 0) || fsync(recovery_dir) ? -1 : 0;
}
static volatile sig_atomic_t stopping = 0;
struct process_identity { pid_t pid; uint64_t seconds, micros; };
struct uid_snapshot { struct process_identity entries[4096]; int count; };
static void stop(int signal) { (void)signal; stopping = 1; }
static int identity(const char *text, unsigned *id) {
    if (!text[0] || text[0] == '0') return 0;
    for (const char *p = text; *p; ++p) if (*p < '0' || *p > '9') return 0;
    errno = 0;
    char *end;
    unsigned long value = strtoul(text, &end, 10);
    if (errno || *end || value < 200 || value > INT_MAX) return 0;
    *id = (unsigned)value;
    return 1;
}
static void failed_exec(int fd) {
    int failure = errno ? errno : EINVAL;
    (void)write(fd, &failure, sizeof(failure));
    _exit(125);
}
static int snapshot_uid(uid_t uid, struct uid_snapshot *snapshot) {
    pid_t pids[8192];
    int bytes = proc_listpids(PROC_UID_ONLY, uid, pids, sizeof(pids));
    if (bytes < 0 || bytes >= (int)sizeof(pids)) return -1;
    snapshot->count = 0;
    for (int i = 0; i < bytes / (int)sizeof(pid_t); ++i) {
        if (pids[i] <= 0) continue;
        struct proc_bsdinfo info; errno = 0;
        int result = proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info));
        if (!result && errno == ESRCH) continue;
        if (result != sizeof(info)) return -1;
        if (info.pbi_uid != uid || info.pbi_status == SZOMB) continue;
        if (snapshot->count >= 4096) return -1;
        snapshot->entries[snapshot->count++] = (struct process_identity){pids[i], info.pbi_start_tvsec, info.pbi_start_tvusec};
    }
    return 0;
}
// A successful group drain is not proof that an escaped descendant was stopped.
// Never signal a PID discovered this way; report uncertainty to the service.
static int no_new_uid_processes(uid_t uid, const struct uid_snapshot *before) {
    struct uid_snapshot after;
    if (snapshot_uid(uid, &after)) return 0;
    for (int i = 0; i < after.count; ++i) {
        int found = 0;
        for (int j = 0; j < before->count; ++j) {
            struct process_identity a = after.entries[i], b = before->entries[j];
            if (a.pid == b.pid && a.seconds == b.seconds && a.micros == b.micros) { found = 1; break; }
        }
        if (!found) return 0;
    }
    return 1;
}
// Keep the group leader unreaped, so its PID/process group cannot be reused while
// we signal the group. Zombies have stopped executing and cannot fork new work.
static int active_group(pid_t group) {
    siginfo_t leader = {0};
    if (waitid(P_PID, (id_t)group, &leader, WEXITED | WNOHANG | WNOWAIT)) { fprintf(stderr, "guardian wait observation failed errno=%d\n", errno); return -1; }
    int bytes = proc_listpids(PROC_PGRP_ONLY, (uint32_t)group, NULL, 0);
    if (bytes <= 0) { fprintf(stderr, "guardian group enumeration bytes=%d errno=%d\n", bytes, errno); return bytes == 0 ? 0 : -1; }
    if (bytes > 1024 * 1024) return -1;
    size_t capacity = (size_t)bytes + 4096;
    pid_t *pids = calloc(1, capacity);
    if (!pids) return -1;
    bytes = proc_listpids(PROC_PGRP_ONLY, (uint32_t)group, pids, (int)capacity);
    int active = 0;
    if (bytes < 0 || (size_t)bytes >= capacity) active = -1;
    else for (int i = 0; i < bytes / (int)sizeof(pid_t); ++i) {
        if (pids[i] <= 0) continue;
        if (pids[i] == group && leader.si_pid == group) continue;
        struct proc_bsdinfo info;
        int result = proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info));
        if (result == 0 && errno == ESRCH) continue;
        if (result != sizeof(info)) { fprintf(stderr, "guardian process observation failed errno=%d bytes=%d\n", errno, result); active = -1; break; }
        if (info.pbi_pgid == (uint32_t)group && info.pbi_status != SZOMB) ++active;
    }
    free(pids);
    return active;
}
// This optional cleanup is restricted to an installed, non-login service identity.
// It never targets the interactive user's launchd domain or accepts a command.
static int dedicated_identity(unsigned uid, unsigned gid, const char *home) {
    struct passwd *account = getpwuid((uid_t)uid);
    return uid < 500 && account && account->pw_gid == gid &&
        !strncmp(account->pw_name, "_saycodebrowser", 15) &&
        !strcmp(account->pw_shell, "/usr/bin/false") && !strcmp(account->pw_dir, home) &&
        !strcmp(home, "/Library/Application Support/SaycodeNative/browser-profile");
}
static int stop_user_domain(unsigned uid) {
    char domain[40]; snprintf(domain, sizeof(domain), "user/%u", uid);
    pid_t cleanup = fork();
    if (cleanup < 0) return -1;
    if (!cleanup) {
        int null = open("/dev/null", O_RDWR);
        if (null < 0) _exit(125);
        for (int fd = 0; fd <= 2; ++fd) if (dup2(null, fd) < 0) _exit(125);
        // No browser pipes, locks or control streams belong to launchctl.
        long limit = sysconf(_SC_OPEN_MAX);
        if (limit < 0 || limit > INT_MAX) _exit(125);
        for (int fd = 3; fd < limit; ++fd) close(fd);
        char *const args[] = {"/bin/launchctl", "bootout", domain, NULL};
        char *const env[] = {"PATH=/usr/bin:/bin", NULL};
        execve(args[0], args, env); _exit(125);
    }
    for (int attempt = 0; attempt < 40; ++attempt) {
        int status;
        pid_t observed = waitpid(cleanup, &status, WNOHANG);
        // An absent domain can also return nonzero. The final UID inventory,
        // not launchctl's exit code, proves cleanup.
        if (observed == cleanup) return 0;
        if (observed < 0 && errno != EINTR) return -1;
        usleep(50000);
    }
    kill(cleanup, SIGKILL);
    while (waitpid(cleanup, NULL, 0) < 0) if (errno != EINTR) break;
    return -1;
}
// Administrator-invoked only, never used on the automatic restart path.
static int recover_stopped_identity(unsigned uid, unsigned gid, const char *home, const char *path) {
    if (!dedicated_identity(uid, gid, home) || lock_recovery(path)) return 126;
    int fd = openat(recovery_dir, "active", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    struct stat info;
    if (fd < 0 || fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_uid != 0 || info.st_nlink != 1 ||
        (info.st_mode & 07777) != 0600 || !no_acl(fd)) return 126;
    char receipt[80] = {0}, canonical[80];
    ssize_t length = read(fd, receipt, sizeof(receipt) - 1); close(fd);
    unsigned recorded_uid; int previous;
    if (length <= 0 || sscanf(receipt, "v1 uid=%u guardian=%d", &recorded_uid, &previous) != 2 ||
        recorded_uid != uid || previous <= 1) return 126;
    int expected = snprintf(canonical, sizeof(canonical), "v1 uid=%u guardian=%d\n", uid, previous);
    if (length != expected || memcmp(receipt, canonical, (size_t)length)) return 126;
    // Even PID reuse is uncertainty; never signal that process or clear its record.
    errno = 0;
    if (!kill(previous, 0) || errno != ESRCH) return 126;
    for (int attempt = 0; attempt < 3; ++attempt) {
        struct uid_snapshot current;
        if (snapshot_uid((uid_t)uid, &current) || current.count) return 126;
        usleep(50000);
    }
    return complete_recovery() ? 126 : 0;
}
int main(int argc, char **argv) {
    unsigned uid, gid;
    if (argc == 6 && !strcmp(argv[1], "--recover")) {
        if (getuid() != 0 || geteuid() != 0 || !identity(argv[2], &uid) || !identity(argv[3], &gid)) return 125;
        return recover_stopped_identity(uid, gid, argv[4], argv[5]);
    }
    int dedicated = argc > 5 && !strcmp(argv[5], "--dedicated-user-domain");
    int program = dedicated ? 6 : 5;
    if (argc <= program || argc < 6 || getuid() != 0 || geteuid() != 0 ||
        !identity(argv[1], &uid) || !identity(argv[2], &gid) ||
        argv[3][0] != '/' || argv[4][0] != '/' || argv[program][0] != '/' || getppid() <= 1) return 125;
    if (fcntl(3, F_GETFD) < 0 || fcntl(4, F_GETFD) < 0) return 125;
    struct uid_snapshot before;
    if (snapshot_uid((uid_t)uid, &before)) return 125;
    if (dedicated && (!dedicated_identity(uid, gid, argv[3]) || before.count != 0)) return 125;
    if (begin_recovery(argv[4], uid)) { fprintf(stderr, "guardian recovery required\n"); return 126; }
    // The privileged parent owns this pipe. An exec error must never yield ready.
    int exec_status[2];
    if (pipe(exec_status) || fcntl(exec_status[1], F_SETFD, FD_CLOEXEC)) return 125;
    struct sigaction action = {0}; action.sa_handler = stop; sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL)) return 125;
    signal(SIGPIPE, SIG_IGN);
    signal(SIGCHLD, SIG_DFL);
    pid_t parent = getppid();
    pid_t child = fork();
    if (child < 0) return 125;
    if (!child) {
        close(exec_status[0]);
        gid_t group = (gid_t)gid, groups[16];
        // Darwin keeps the effective GID in the kernel group list. Do not use the
        // unlimited getgroups variant: that queries Directory Services instead.
        if (setpgid(0, 0) || setgroups(1, &group) || setgid((gid_t)gid) || setuid((uid_t)uid) ||
            getuid() != uid || geteuid() != uid || getgid() != gid || getegid() != gid ||
            getgroups(16, groups) != 1 || groups[0] != group)
            failed_exec(exec_status[1]);
        if (chdir(argv[3]) || setenv("HOME", argv[3], 1)) failed_exec(exec_status[1]);
        int null = open("/dev/null", O_RDWR);
        if (null < 0) failed_exec(exec_status[1]);
        for (int fd = 0; fd <= 2; ++fd) if (dup2(null, fd) < 0) failed_exec(exec_status[1]);
        if (null > 4 && null != exec_status[1]) close(null);
        for (int fd = 5; fd < exec_status[1]; ++fd) close(fd);
        long descriptors = sysconf(_SC_OPEN_MAX);
        if (descriptors < 0 || descriptors > INT_MAX) failed_exec(exec_status[1]);
        for (int fd = exec_status[1] + 1; fd < descriptors; ++fd) close(fd);
        signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGPIPE, SIG_DFL);
        execv(argv[program], &argv[program]); failed_exec(exec_status[1]);
    }
    close(exec_status[1]); close(3); close(4);
    // Both sides set the group to close the exec/signal race. EACCES means exec won.
    if (setpgid(child, child) && errno != EACCES && errno != ESRCH) stopping = 1;
    int failure = 0;
    ssize_t bytes;
    do { bytes = read(exec_status[0], &failure, sizeof(failure)); } while (bytes < 0 && errno == EINTR && !stopping);
    close(exec_status[0]);
    int launched = bytes == 0 && !stopping;
    if (!launched) fprintf(stderr, "guardian launch failed errno=%d\n", failure);
    if (launched) { printf("{\"version\":1,\"pid\":%d,\"uid\":%u}\n", child, uid); fflush(stdout); }
    char probe[65]; size_t probe_used = 0;
    while (launched && !stopping) {
        siginfo_t status = {0};
        if (waitid(P_PID, (id_t)child, &status, WEXITED | WNOHANG | WNOWAIT) || status.si_pid == child || getppid() != parent) break;
        struct pollfd control = { .fd = STDIN_FILENO, .events = POLLIN };
        int result = poll(&control, 1, 100);
        if (result < 0 && errno != EINTR) break;
        if (result > 0 && control.revents) {
            if (!(control.revents & POLLIN)) break;
            char input[128]; ssize_t count = read(STDIN_FILENO, input, sizeof(input));
            if (count <= 0) break;
            for (ssize_t i = 0; i < count && !stopping; ++i) {
                char c = input[i];
                if (c == '\n') {
                    struct proc_bsdinfo current = {0};
                    if (probe_used != 64 || proc_pidinfo(child, PROC_PIDTBSDINFO, 0, &current, sizeof(current)) != sizeof(current) ||
                        current.pbi_pid != (uint32_t)child || current.pbi_uid != uid) { stopping = 1; break; }
                    probe[64] = 0;
                    unsigned long long start = (unsigned long long)current.pbi_start_tvsec * 1000000 + current.pbi_start_tvusec;
                    printf("{\"version\":1,\"nonce\":\"%s\",\"pid\":%d,\"uid\":%u,\"startedAt\":\"%llu\"}\n", probe, child, uid, start);
                    if (fflush(stdout)) { stopping = 1; break; }
                    probe_used = 0;
                } else if (probe_used < 64 && ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) probe[probe_used++] = c;
                else stopping = 1;
            }
        }
    }
    int drained = 0;
    for (int attempt = 0; attempt < 100; ++attempt) {
        int active = active_group(child);
        if (active == 0) { drained = 1; break; }
        if (active < 0) break;
        // Darwin can return EPERM when a group contains only zombies; observe
        // first. Never reap the leader before the final signal and observation.
        if (kill(-child, SIGKILL) && errno != ESRCH) break;
        usleep(50000);
    }
    if (!drained) { fprintf(stderr, "guardian drain unconfirmed errno=%d\n", errno); return 126; }
    while (waitpid(child, NULL, 0) < 0) if (errno != EINTR) { fprintf(stderr, "guardian reap failed errno=%d\n", errno); return 126; }
    if (dedicated && stop_user_domain(uid)) return 126;
    if (dedicated) {
        for (int attempt = 0; attempt < 20 && !no_new_uid_processes((uid_t)uid, &before); ++attempt) usleep(50000);
    }
    if (!no_new_uid_processes((uid_t)uid, &before)) { fprintf(stderr, "guardian identity cleanup unconfirmed\n"); return 126; }
    if (complete_recovery()) { fprintf(stderr, "guardian recovery commit failed\n"); return 126; }
    return launched ? 0 : 125;
}
