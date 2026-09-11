/**
 * The runtime half of a personal AI login (specs/managed-cloud-byos R23~R25).
 *
 * The requester logs in **on the machine that will run their work**, and the
 * credential never leaves it: the parent drives the flow through
 * `managed:ai-auth` and stores only what this module returns — a state, a
 * version, a login URL and a masked account label. No token, no refresh token,
 * no PKCE verifier is ever in a reply, in a log line or in a failure.
 *
 * ## The auth home
 *
 *   `/workspace/.auth`                    root:root 0711, created at boot
 *   `/workspace/.auth/<connectionId>`     provider uid 0700
 *   `/workspace/.auth/<connectionId>/connection.json`   the marker
 *   `/workspace/.auth/<connectionId>/claude`            `CLAUDE_CONFIG_DIR`
 *   `/workspace/.auth/<connectionId>/codex`             `CODEX_HOME`
 *
 * Outside `/workspace/project` and `/workspace/.codex`, so no checkpoint ever
 * contains a credential. One directory per connection, so two people sharing a
 * workspace never share a login and a logout removes exactly one.
 *
 * The marker records which version of the connection the credential belongs
 * to. It is a **record for the daemon**, not a defence against the provider
 * uid — that uid owns the directory and can rewrite anything inside it. What
 * the version actually protects is the parent's side: a run admitted on
 * version N refuses to start against a marker saying anything else (R24), so a
 * logout followed by a different login cannot silently serve a pending Run.
 *
 * ## Why everything is injected
 *
 * The filesystem, the child process, the clock and `fetch` all arrive as
 * dependencies. The real thing writes as root into a path that exists only on
 * a Fly runtime and spawns `codex` as another uid; a test has none of that.
 * What the tests can then cover is every branch except the two that need a
 * real subscription — the vendor's token endpoint and the vendor's device
 * flow — and those are the only parts left to a live session.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import {
    chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';

import { decodeJwtPayload } from '@/commands/connect/utils';
import {
    buildClaudeAuthorizeUrl,
    claudeOAuthRedirectUri,
    claudeTokenExchangeBody,
    CLAUDE_OAUTH_TOKEN_URL,
    generateClaudeOAuthState,
    generateClaudePkce,
} from '@/commands/connect/claudeOAuth';
import {
    MANAGED_AI_AUTH_HOME_ROOT,
    MANAGED_AI_AUTH_MARKER_FILE,
    MANAGED_AI_AUTH_MARKER_VERSION,
    managedAiAuthConnectionDir,
    managedAiAuthProviderHome,
    type ManagedAiAuthMarker,
    type ManagedAiAuthProvider,
    type ManagedAiAuthRpcParams,
    type ManagedAiAuthRpcResult,
} from '@/managed/managedAiAuth';
import { logger } from '@/ui/logger';

/**
 * What the parent is told when something goes wrong. Fixed strings, all of
 * them: a failure that carried the provider's own text would put a URL with a
 * code in it, or the body of a refused token exchange, into the parent's
 * database.
 */
export const MANAGED_AI_AUTH_FAILURES = {
    inProgress: 'ai-auth-login-in-progress',
    noPending: 'ai-auth-no-pending-login',
    versionConflict: 'ai-auth-version-conflict',
    exchangeFailed: 'ai-auth-exchange-failed',
    providerUnavailable: 'ai-auth-provider-unavailable',
} as const;

export const MANAGED_AI_AUTH_REFUSAL_CODES: readonly string[] = Object.values(MANAGED_AI_AUTH_FAILURES);

/**
 * The scopes a managed login asks for.
 *
 * `user:inference` is what the CLI spends; `user:profile` is what makes the
 * reply carry an account to display. Without a label the parent can only say
 * "connected", and a user with two Claude accounts cannot tell which one this
 * runtime is spending.
 */
const CLAUDE_MANAGED_SCOPE = 'user:profile user:inference';

/** Refused by the store, with a code the parent can act on. */
export class ManagedAiAuthError extends Error {
    constructor(readonly code: string) {
        super(code);
        this.name = 'ManagedAiAuthError';
    }
}

export type ManagedAiAuthStatSnapshot = {
    isSymbolicLink: boolean;
    isDirectory: boolean;
    isFile: boolean;
};

export type ManagedAiAuthFs = {
    /** `null` for a path that is not there. Never follows a link. */
    lstat: (path: string) => ManagedAiAuthStatSnapshot | null;
    mkdir: (path: string, mode: number) => void;
    chmod: (path: string, mode: number) => void;
    chown: (path: string, uid: number, gid: number) => void;
    /** Exclusive create. An existing path — or a planted link — must fail. */
    writeNew: (path: string, contents: string, mode: number) => void;
    readFile: (path: string) => string | null;
    rename: (from: string, to: string) => void;
    removeTree: (path: string) => void;
};

export type ManagedAiAuthChild = {
    onStdout: (listener: (chunk: string) => void) => void;
    onExit: (listener: (code: number | null) => void) => void;
    onError: (listener: () => void) => void;
    kill: () => void;
};

export type ManagedAiAuthSpawn = (input: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    uid: number;
    gid: number;
}) => ManagedAiAuthChild;

export type ManagedAiAuthStoreDeps = {
    /** The uid the provider CLI runs as, and the one that owns every login. */
    provider: { uid: number; gid: number };
    now: () => number;
    fs?: ManagedAiAuthFs;
    spawn?: ManagedAiAuthSpawn;
    fetchImpl?: typeof fetch;
    /** The root, overridden only by tests — production has exactly one. */
    root?: string;
    /**
     * How long `login-start` waits for the device flow to print its URL.
     *
     * Bounded because this reply is what the user is waiting on. A `codex`
     * that never prints one is refused as unavailable rather than left holding
     * the RPC open until the parent's own timeout fires.
     */
    deviceLoginStartTimeoutMs?: number;
};

/** The store, as the RPC surface uses it. */
export type ManagedAiAuthStore = {
    run: (params: ManagedAiAuthRpcParams) => Promise<ManagedAiAuthRpcResult>;
    /**
     * Whether this runtime holds the exact login a run was admitted on (R24).
     *
     * Read at spawn, not at admission: the parent fixed the version when it
     * accepted the Run, and between then and now the user may have logged out
     * and back in. A run started against a different login would be work done
     * on an account nobody agreed to spend, so this is a refusal rather than a
     * reason to fall back to anything.
     */
    holdsConnection: (input: {
        connectionId: string;
        provider: ManagedAiAuthProvider;
        connectionVersion: number;
    }) => boolean;
    /** Drops pending logins and kills their children. For daemon teardown. */
    close: () => void;
};

/**
 * A login that has been started and not finished.
 *
 * Kept in memory only, and deliberately: the verifier and the state are what
 * an attacker would need to complete somebody else's login, and a restart
 * losing them costs one retry. `pendingVersion` is the version the marker will
 * record on success — the parent promotes its own row only when it sees that
 * version reported as connected, which is what makes a lost reply retryable.
 */
type PendingLogin = {
    provider: ManagedAiAuthProvider;
    pendingVersion: number;
    expiresAt: number;
    loginUrl: string;
    userCode?: string;
    /** claude only. Never written down and never replied with. */
    verifier?: string;
    state?: string;
    /** codex only. */
    child?: ManagedAiAuthChild;
    deviceOutcome?: 'running' | 'succeeded' | 'failed';
};

const CLAUDE_CREDENTIAL_FILE = '.credentials.json';
const CODEX_CREDENTIAL_FILE = 'auth.json';

function credentialPath(root: string, connectionId: string, provider: ManagedAiAuthProvider): string {
    const home = withRoot(root, managedAiAuthProviderHome(connectionId, provider));
    return `${home}/${provider === 'claude' ? CLAUDE_CREDENTIAL_FILE : CODEX_CREDENTIAL_FILE}`;
}

/**
 * Re-roots a canonical path for a test.
 *
 * Production passes the canonical root and this is the identity. The path
 * helpers in `managedAiAuth` are the contract with the parent, so they are the
 * ones that validate the connection id — this only moves the prefix, and only
 * a prefix the caller supplied.
 */
function withRoot(root: string, canonical: string): string {
    if (root === MANAGED_AI_AUTH_HOME_ROOT) return canonical;
    return `${root}${canonical.slice(MANAGED_AI_AUTH_HOME_ROOT.length)}`;
}

export function createManagedAiAuthStore(deps: ManagedAiAuthStoreDeps): ManagedAiAuthStore {
    const root = deps.root ?? MANAGED_AI_AUTH_HOME_ROOT;
    const fs = deps.fs ?? defaultManagedAiAuthFs;
    const spawn = deps.spawn ?? defaultManagedAiAuthSpawn;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const deviceTimeoutMs = deps.deviceLoginStartTimeoutMs ?? 20_000;

    const pending = new Map<string, PendingLogin>();
    const lastFailure = new Map<string, string>();
    /**
     * One action at a time per connection.
     *
     * Two `login-start`s racing would each see no pending login and each spawn
     * a device flow into the same home; a `logout` racing a `login-complete`
     * would delete the directory the exchange is about to write into. The
     * chain is per connection because that is the unit everything here acts
     * on — serialising the whole store would make one slow device login block
     * every other user's status read.
     */
    const chains = new Map<string, Promise<unknown>>();

    const serialize = <T>(connectionId: string, work: () => Promise<T>): Promise<T> => {
        const previous = chains.get(connectionId) ?? Promise.resolve();
        const next = previous.then(work, work);
        chains.set(connectionId, next.then(() => undefined, () => undefined));
        return next;
    };

    /**
     * Refuses any path whose chain contains something other than a directory
     * we own.
     *
     * A symlink anywhere in the chain turns a `0700` mkdir and a `0600` write
     * into a write somewhere else entirely — and the thing being written is a
     * credential. Checked with `lstat` immediately before each step rather
     * than once at the top, because each step creates the parent of the next.
     */
    const assertDirectoryOrAbsent = (path: string): 'directory' | 'absent' => {
        const found = fs.lstat(path);
        if (found === null) return 'absent';
        if (found.isSymbolicLink) throw new ManagedAiAuthError(MANAGED_AI_AUTH_FAILURES.providerUnavailable);
        if (!found.isDirectory) throw new ManagedAiAuthError(MANAGED_AI_AUTH_FAILURES.providerUnavailable);
        return 'directory';
    };

    const ensureDirectory = (path: string, mode: number, uid: number, gid: number): void => {
        if (assertDirectoryOrAbsent(path) === 'absent') {
            // `mkdir`'s mode is masked by the umask, so it is set again.
            fs.mkdir(path, mode);
            fs.chmod(path, mode);
            fs.chown(path, uid, gid);
        }
    };

    /**
     * The connection's own home, made on demand.
     *
     * The root is created by the boot stage; it is made here too when absent,
     * at the same mode and owner, so a runtime that reached this point with no
     * root refuses logins rather than being silently unable to serve them.
     */
    const ensureConnectionHome = (connectionId: string, provider: ManagedAiAuthProvider): string => {
        ensureDirectory(root, 0o711, 0, 0);
        const dir = withRoot(root, managedAiAuthConnectionDir(connectionId));
        ensureDirectory(dir, 0o700, deps.provider.uid, deps.provider.gid);
        const home = withRoot(root, managedAiAuthProviderHome(connectionId, provider));
        ensureDirectory(home, 0o700, deps.provider.uid, deps.provider.gid);
        return home;
    };

    const readMarker = (connectionId: string): ManagedAiAuthMarker | null => {
        const path = `${withRoot(root, managedAiAuthConnectionDir(connectionId))}/${MANAGED_AI_AUTH_MARKER_FILE}`;
        const raw = fs.readFile(path);
        if (raw === null) return null;
        try {
            const parsed = JSON.parse(raw) as Partial<ManagedAiAuthMarker>;
            if (parsed.v !== MANAGED_AI_AUTH_MARKER_VERSION) return null;
            if (parsed.provider !== 'claude' && parsed.provider !== 'codex') return null;
            if (typeof parsed.connectionVersion !== 'number' || !Number.isSafeInteger(parsed.connectionVersion)) {
                return null;
            }
            return {
                v: MANAGED_AI_AUTH_MARKER_VERSION,
                provider: parsed.provider,
                connectionVersion: parsed.connectionVersion,
                ...(typeof parsed.accountLabel === 'string' ? { accountLabel: parsed.accountLabel } : {}),
            };
        } catch {
            // A marker this runtime cannot read is not a credential it may
            // report as connected.
            return null;
        }
    };

    /**
     * Writes the marker, temp-then-rename.
     *
     * Exclusive create on the temp name and a rename over the final one: a
     * reader never sees a half-written marker, and the write cannot land on
     * something that was already there under another name.
     */
    const writeMarker = (connectionId: string, marker: ManagedAiAuthMarker): void => {
        const dir = withRoot(root, managedAiAuthConnectionDir(connectionId));
        const temp = `${dir}/${MANAGED_AI_AUTH_MARKER_FILE}.${randomBytes(8).toString('hex')}`;
        fs.writeNew(temp, JSON.stringify(marker), 0o600);
        fs.chown(temp, deps.provider.uid, deps.provider.gid);
        fs.rename(temp, `${dir}/${MANAGED_AI_AUTH_MARKER_FILE}`);
    };

    const writeCredential = (
        connectionId: string, provider: ManagedAiAuthProvider, contents: string,
    ): void => {
        const home = ensureConnectionHome(connectionId, provider);
        const target = credentialPath(root, connectionId, provider);
        const temp = `${home}/.${randomBytes(8).toString('hex')}`;
        fs.writeNew(temp, contents, 0o600);
        fs.chown(temp, deps.provider.uid, deps.provider.gid);
        fs.rename(temp, target);
    };

    const hasCredential = (connectionId: string, provider: ManagedAiAuthProvider): boolean =>
        fs.readFile(credentialPath(root, connectionId, provider)) !== null;

    /** Drops an expired pending login and kills whatever it was running. */
    const livePending = (connectionId: string): PendingLogin | null => {
        const found = pending.get(connectionId);
        if (!found) return null;
        if (found.expiresAt > deps.now()) return found;
        found.child?.kill();
        pending.delete(connectionId);
        return null;
    };

    const status = (connectionId: string, provider: ManagedAiAuthProvider): ManagedAiAuthRpcResult => {
        /*
         * Order matters, and it is: in progress, then what is on disk, then
         * what went wrong last. A connection with a working credential and a
         * failed *re-login* is still connected — reporting it as failed would
         * tell the parent to stop dispatching work the runtime can still do.
         */
        const live = livePending(connectionId);
        if (live && live.provider === provider) {
            if (live.deviceOutcome === 'succeeded' || live.deviceOutcome === 'failed') {
                // The device flow settled while nobody was asking. Reported
                // through the same path as an explicit completion.
                return settleDeviceLogin(connectionId, live);
            }
            return {
                state: 'pending',
                connectionVersion: null,
                loginMethod: live.verifier === undefined ? 'device-code' : 'paste-code',
                loginUrl: live.loginUrl,
                ...(live.userCode === undefined ? {} : { userCode: live.userCode }),
                expiresAt: live.expiresAt,
            };
        }
        const marker = readMarker(connectionId);
        if (marker && marker.provider === provider && hasCredential(connectionId, provider)) {
            return {
                state: 'connected',
                connectionVersion: marker.connectionVersion,
                ...(marker.accountLabel === undefined ? {} : { accountLabel: marker.accountLabel }),
            };
        }
        const failure = lastFailure.get(connectionId);
        if (failure !== undefined) {
            return { state: 'failed', connectionVersion: null, failureCode: failure };
        }
        return { state: 'absent', connectionVersion: null };
    };

    /** Turns a finished device child into the answer its state implies. */
    const settleDeviceLogin = (connectionId: string, live: PendingLogin): ManagedAiAuthRpcResult => {
        pending.delete(connectionId);
        if (live.deviceOutcome !== 'succeeded' || !hasCredential(connectionId, live.provider)) {
            lastFailure.set(connectionId, MANAGED_AI_AUTH_FAILURES.exchangeFailed);
            return {
                state: 'failed',
                connectionVersion: null,
                failureCode: MANAGED_AI_AUTH_FAILURES.exchangeFailed,
            };
        }
        const label = codexAccountLabel(fs.readFile(credentialPath(root, connectionId, 'codex')));
        writeMarker(connectionId, {
            v: MANAGED_AI_AUTH_MARKER_VERSION,
            provider: 'codex',
            connectionVersion: live.pendingVersion,
            ...(label === null ? {} : { accountLabel: label }),
        });
        lastFailure.delete(connectionId);
        return {
            state: 'connected',
            connectionVersion: live.pendingVersion,
            ...(label === null ? {} : { accountLabel: label }),
        };
    };

    const startClaudeLogin = (
        connectionId: string, connectionVersion: number, expiresAt: number,
    ): ManagedAiAuthRpcResult => {
        // The home exists before the URL is handed out: a user who completes
        // the flow must not then find there is nowhere to put the result.
        ensureConnectionHome(connectionId, 'claude');
        const { verifier, challenge } = generateClaudePkce();
        const state = generateClaudeOAuthState();
        const loginUrl = buildClaudeAuthorizeUrl({
            challenge,
            state,
            redirectUri: claudeOAuthRedirectUri(),
            scope: CLAUDE_MANAGED_SCOPE,
        });
        pending.set(connectionId, {
            provider: 'claude', pendingVersion: connectionVersion, expiresAt, loginUrl, verifier, state,
        });
        return {
            state: 'pending',
            connectionVersion: null,
            loginMethod: 'paste-code',
            loginUrl,
            expiresAt,
        };
    };

    const completeClaudeLogin = async (
        connectionId: string, live: PendingLogin, code: string | undefined,
    ): Promise<ManagedAiAuthRpcResult> => {
        if (code === undefined) throw new ManagedAiAuthError(MANAGED_AI_AUTH_FAILURES.noPending);
        // claude.ai shows the code as `code#state`. Both forms are accepted,
        // and a state that disagrees is refused rather than dropped: it is the
        // only evidence that this code belongs to the login we started.
        const hashIndex = code.indexOf('#');
        const authorizationCode = hashIndex === -1 ? code : code.slice(0, hashIndex);
        if (hashIndex !== -1 && code.slice(hashIndex + 1) !== live.state) {
            throw new ManagedAiAuthError(MANAGED_AI_AUTH_FAILURES.versionConflict);
        }
        let tokens: ClaudeTokenResponse;
        try {
            const response = await fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(claudeTokenExchangeBody({
                    code: authorizationCode,
                    verifier: live.verifier!,
                    redirectUri: claudeOAuthRedirectUri(),
                    state: live.state!,
                })),
            });
            if (!response.ok) throw new Error('refused');
            tokens = await response.json() as ClaudeTokenResponse;
            if (typeof tokens.access_token !== 'string' || tokens.access_token === '') {
                throw new Error('no access token');
            }
        } catch {
            /*
             * The reason stays here. A token endpoint's body can quote the
             * code that was sent, and the code is the one thing in this flow
             * that must not reach the parent's database.
             */
            logger.debug('[managed] ai-auth claude code exchange failed');
            pending.delete(connectionId);
            lastFailure.set(connectionId, MANAGED_AI_AUTH_FAILURES.exchangeFailed);
            return {
                state: 'failed',
                connectionVersion: null,
                failureCode: MANAGED_AI_AUTH_FAILURES.exchangeFailed,
            };
        }
        // The shape Claude Code itself reads, and the only one it reads.
        const credential = {
            claudeAiOauth: {
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token ?? '',
                expiresAt: deps.now() + (typeof tokens.expires_in === 'number' ? tokens.expires_in * 1000 : 0),
                scopes: typeof tokens.scope === 'string' ? tokens.scope.split(' ').filter(Boolean) : [],
                ...(typeof tokens.subscription_type === 'string'
                    ? { subscriptionType: tokens.subscription_type }
                    : {}),
            },
        };
        writeCredential(connectionId, 'claude', JSON.stringify(credential));
        const label = maskAccountLabel(tokens.account?.email_address);
        // The marker **after** the credential: a marker pointing at a
        // credential that is not there would report connected to a parent that
        // would then dispatch a run with nothing to run it on.
        writeMarker(connectionId, {
            v: MANAGED_AI_AUTH_MARKER_VERSION,
            provider: 'claude',
            connectionVersion: live.pendingVersion,
            ...(label === null ? {} : { accountLabel: label }),
        });
        pending.delete(connectionId);
        lastFailure.delete(connectionId);
        return {
            state: 'connected',
            connectionVersion: live.pendingVersion,
            ...(label === null ? {} : { accountLabel: label }),
        };
    };

    const startCodexLogin = (
        connectionId: string, connectionVersion: number, expiresAt: number,
    ): Promise<ManagedAiAuthRpcResult> => {
        const home = ensureConnectionHome(connectionId, 'codex');
        const connectionDir = withRoot(root, managedAiAuthConnectionDir(connectionId));
        let child: ManagedAiAuthChild;
        try {
            child = spawn({
                command: 'codex',
                args: ['login', '--device-auth'],
                /*
                 * Two variables and nothing else. `CODEX_HOME` is where the
                 * login lands; `HOME` is there because the CLI writes cache
                 * beside it and the provider uid has no passwd entry in this
                 * image — with no `HOME` it resolves one it cannot write and
                 * dies before printing anything.
                 */
                env: { CODEX_HOME: home, HOME: connectionDir, PATH: '/usr/local/bin:/usr/bin:/bin' },
                cwd: connectionDir,
                uid: deps.provider.uid,
                gid: deps.provider.gid,
            });
        } catch {
            logger.debug('[managed] ai-auth codex login could not be started');
            throw new ManagedAiAuthError(MANAGED_AI_AUTH_FAILURES.providerUnavailable);
        }
        const entry: PendingLogin = {
            provider: 'codex',
            pendingVersion: connectionVersion,
            expiresAt,
            loginUrl: '',
            child,
            deviceOutcome: 'running',
        };
        pending.set(connectionId, entry);

        return new Promise<ManagedAiAuthRpcResult>((resolve, reject) => {
            let settled = false;
            let buffered = '';
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                // Nothing to show the user. Killed rather than left running:
                // an orphan device flow would later write a credential nobody
                // is waiting for, under a version the parent never promoted.
                child.kill();
                pending.delete(connectionId);
                logger.debug('[managed] ai-auth codex login printed no verification url');
                reject(new ManagedAiAuthError(MANAGED_AI_AUTH_FAILURES.providerUnavailable));
            }, deviceTimeoutMs);
            timer.unref?.();

            const finishPending = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({
                    state: 'pending',
                    connectionVersion: null,
                    loginMethod: 'device-code',
                    loginUrl: entry.loginUrl,
                    ...(entry.userCode === undefined ? {} : { userCode: entry.userCode }),
                    expiresAt,
                });
            };

            child.onStdout((chunk) => {
                buffered += chunk;
                const parsed = parseCodexDeviceLogin(buffered);
                if (parsed === null) return;
                entry.loginUrl = parsed.loginUrl;
                if (parsed.userCode !== undefined) entry.userCode = parsed.userCode;
                finishPending();
            });
            child.onError(() => {
                entry.deviceOutcome = 'failed';
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                pending.delete(connectionId);
                reject(new ManagedAiAuthError(MANAGED_AI_AUTH_FAILURES.providerUnavailable));
            });
            child.onExit((code) => {
                entry.deviceOutcome = code === 0 ? 'succeeded' : 'failed';
                if (settled) return;
                // It ended before printing a URL: there is no login to show.
                settled = true;
                clearTimeout(timer);
                pending.delete(connectionId);
                lastFailure.set(connectionId, MANAGED_AI_AUTH_FAILURES.exchangeFailed);
                resolve({
                    state: 'failed',
                    connectionVersion: null,
                    failureCode: MANAGED_AI_AUTH_FAILURES.exchangeFailed,
                });
            });
        });
    };

    const logout = (connectionId: string, connectionVersion: number): ManagedAiAuthRpcResult => {
        const live = pending.get(connectionId);
        live?.child?.kill();
        pending.delete(connectionId);
        lastFailure.delete(connectionId);
        const dir = withRoot(root, managedAiAuthConnectionDir(connectionId));
        // The same refusal the writes make: a symlinked connection directory
        // would turn this removal into a removal of whatever it points at.
        if (assertDirectoryOrAbsent(dir) === 'directory') fs.removeTree(dir);
        // The version the parent asked for, echoed back: it is the one that
        // records the revocation on its side (R25).
        return { state: 'absent', connectionVersion };
    };

    const run = async (params: ManagedAiAuthRpcParams): Promise<ManagedAiAuthRpcResult> => {
        const { connectionId, provider } = params;
        if (params.action === 'status') return status(connectionId, provider);
        if (params.action === 'logout') return logout(connectionId, params.connectionVersion!);
        if (params.action === 'login-cancel') {
            const live = pending.get(connectionId);
            live?.child?.kill();
            pending.delete(connectionId);
            // The existing credential is untouched: a cancelled *re*-login
            // leaves the connection exactly as it was.
            return status(connectionId, provider);
        }
        if (params.action === 'login-start') {
            const live = livePending(connectionId);
            if (live) throw new ManagedAiAuthError(MANAGED_AI_AUTH_FAILURES.inProgress);
            const marker = readMarker(connectionId);
            // A login that would record a version no later than the one on
            // disk cannot be told apart from a replay of the one already
            // there, and promoting it would move the parent's row backwards.
            if (marker !== null && params.connectionVersion! <= marker.connectionVersion) {
                throw new ManagedAiAuthError(MANAGED_AI_AUTH_FAILURES.versionConflict);
            }
            lastFailure.delete(connectionId);
            return provider === 'claude'
                ? startClaudeLogin(connectionId, params.connectionVersion!, params.expiresAt!)
                : startCodexLogin(connectionId, params.connectionVersion!, params.expiresAt!);
        }
        // login-complete
        const live = livePending(connectionId);
        if (!live || live.provider !== provider) {
            throw new ManagedAiAuthError(MANAGED_AI_AUTH_FAILURES.noPending);
        }
        if (params.connectionVersion !== undefined && params.connectionVersion !== live.pendingVersion) {
            throw new ManagedAiAuthError(MANAGED_AI_AUTH_FAILURES.versionConflict);
        }
        if (provider === 'codex') {
            // The device flow finishes on its own; completing it is reading
            // what it did. Still running is `pending`, and the parent asks
            // again rather than being told an answer that does not exist yet.
            if (live.deviceOutcome === 'running') return status(connectionId, provider);
            return settleDeviceLogin(connectionId, live);
        }
        return completeClaudeLogin(connectionId, live, params.code);
    };

    return {
        run: (params) => serialize(params.connectionId, () => run(params)),
        holdsConnection: ({ connectionId, provider, connectionVersion }) => {
            const marker = readMarker(connectionId);
            return marker !== null
                && marker.provider === provider
                && marker.connectionVersion === connectionVersion
                // The marker alone is not the login: a credential removed
                // beneath it would let a run start with nothing to run on.
                && hasCredential(connectionId, provider);
        },
        close: () => {
            for (const live of pending.values()) live.child?.kill();
            pending.clear();
        },
    };
}

type ClaudeTokenResponse = {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    subscription_type?: string;
    account?: { email_address?: string };
};

/**
 * What `codex login --device-auth` put on its output.
 *
 * Read liberally on purpose: the exact wording belongs to a CLI this package
 * does not control, and a parser pinned to one phrasing silently stops finding
 * the URL on the next release. The first `https://` URL and a code shaped like
 * `ABCD-EFGH` are the two things every rendering of a device flow has.
 */
export function parseCodexDeviceLogin(text: string): { loginUrl: string; userCode?: string } | null {
    const url = text.match(/https:\/\/[^\s"'<>]+/);
    if (!url) return null;
    const dashed = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/);
    if (dashed) return { loginUrl: url[0], userCode: dashed[0] };
    // A code announced by name, on the same line or the next one.
    const labelled = text.match(/code[^A-Za-z0-9]{0,20}([A-Z0-9][A-Z0-9-]{3,15})/i);
    return labelled ? { loginUrl: url[0], userCode: labelled[1] } : { loginUrl: url[0] };
}

/** `alice@example.com` → `al***@example.com`. Never the whole address. */
export function maskAccountLabel(email: string | undefined): string | null {
    if (typeof email !== 'string') return null;
    const at = email.indexOf('@');
    if (at <= 0 || at === email.length - 1) return null;
    return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

/** The account a codex login belongs to, from the id token it stored. */
export function codexAccountLabel(raw: string | null): string | null {
    if (raw === null) return null;
    try {
        const parsed = JSON.parse(raw) as { tokens?: { id_token?: unknown }; id_token?: unknown };
        const idToken = parsed.tokens?.id_token ?? parsed.id_token;
        if (typeof idToken !== 'string') return null;
        const payload = decodeJwtPayload(idToken);
        const email = payload?.email;
        return maskAccountLabel(typeof email === 'string' ? email : undefined);
    } catch {
        return null;
    }
}

export const defaultManagedAiAuthFs: ManagedAiAuthFs = {
    lstat: (path) => {
        const found = lstatSync(path, { throwIfNoEntry: false });
        if (!found) return null;
        return {
            isSymbolicLink: found.isSymbolicLink(),
            isDirectory: found.isDirectory(),
            isFile: found.isFile(),
        };
    },
    // Never `recursive`: a parent this code did not make is a parent nobody
    // checked, and every parent here is made one step earlier.
    mkdir: (path, mode) => { mkdirSync(path, { mode }); },
    chmod: (path, mode) => { chmodSync(path, mode); },
    chown: (path, uid, gid) => { chownSync(path, uid, gid); },
    writeNew: (path, contents, mode) => { writeFileSync(path, contents, { mode, flag: 'wx' }); },
    readFile: (path) => {
        try {
            return readFileSync(path, 'utf8');
        } catch {
            return null;
        }
    },
    rename: (from, to) => { renameSync(from, to); },
    removeTree: (path) => { rmSync(path, { recursive: true, force: true }); },
};

export const defaultManagedAiAuthSpawn: ManagedAiAuthSpawn = (input) => {
    const child = nodeSpawn(input.command, input.args, {
        cwd: input.cwd,
        // Built from nothing, like every other managed provider environment:
        // an inherited variable here is a way to point the login somewhere
        // else, and this one writes a credential.
        env: input.env,
        uid: input.uid,
        gid: input.gid,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
        onStdout: (listener) => {
            // stderr too: device flows print their instructions to either, and
            // a parser watching one stream finds nothing on half of them.
            child.stdout?.setEncoding('utf8');
            child.stderr?.setEncoding('utf8');
            child.stdout?.on('data', (chunk: string) => listener(chunk));
            child.stderr?.on('data', (chunk: string) => listener(chunk));
        },
        onExit: (listener) => { child.on('exit', (code) => listener(code)); },
        onError: (listener) => { child.on('error', () => listener()); },
        kill: () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } },
    };
};
