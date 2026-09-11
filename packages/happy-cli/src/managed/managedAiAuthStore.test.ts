/**
 * The auth home, driven end to end with the real filesystem.
 *
 * Everything except the two vendor conversations is exercised here: the layout
 * and its modes, the marker, the version rules, cancellation, logout, and what
 * is and is not in a reply. The vendor's token endpoint and the vendor's
 * device flow are faked — completing either for real needs a subscription
 * account, and that is the part a live session has to do.
 *
 * Ownership is the one thing that cannot run here: giving a file away needs
 * root. So `chown` is recorded rather than applied, and what is asserted is
 * that the right uid was asked for on the right path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    codexAccountLabel,
    createManagedAiAuthStore,
    defaultManagedAiAuthFs,
    MANAGED_AI_AUTH_FAILURES,
    ManagedAiAuthError,
    maskAccountLabel,
    parseCodexDeviceLogin,
    type ManagedAiAuthChild,
    type ManagedAiAuthFs,
    type ManagedAiAuthSpawn,
    type ManagedAiAuthStore,
} from '@/managed/managedAiAuthStore';
import { MANAGED_AI_AUTH_MARKER_FILE } from '@/managed/managedAiAuth';

const CONNECTION = 'conn-0123456789ab';
const NOW = 1_800_000_000_000;

let root: string;
let now = NOW;

const uid = 4242;
const gid = 4242;

/**
 * The real filesystem, with ownership **recorded** instead of applied.
 *
 * Giving a file away needs root, and this suite is not root — so the one call
 * that cannot run here is observed instead. Everything else (the modes, the
 * exclusive create, the rename, the symlink refusals) is the production path
 * against a real directory.
 */
let owned: Array<{ path: string; uid: number; gid: number }> = [];
const recordingFs: ManagedAiAuthFs = {
    ...defaultManagedAiAuthFs,
    chown: (path, target, group) => { owned.push({ path, uid: target, gid: group }); },
};

const connectionDir = () => join(root, CONNECTION);
const claudeCredential = () => join(connectionDir(), 'claude', '.credentials.json');
const codexCredential = () => join(connectionDir(), 'codex', 'auth.json');
const markerPath = () => join(connectionDir(), MANAGED_AI_AUTH_MARKER_FILE);

/** A token endpoint that answers once with whatever this test wants. */
function claudeTokenEndpoint(answer: { ok: boolean; body?: unknown }): typeof fetch {
    return (async () => ({
        ok: answer.ok,
        json: async () => answer.body ?? {},
    })) as unknown as typeof fetch;
}

const ACCEPTED_TOKENS = {
    access_token: 'access-token-value',
    refresh_token: 'refresh-token-value',
    expires_in: 3600,
    scope: 'user:profile user:inference',
    subscription_type: 'max',
    account: { email_address: 'alice@example.test' },
};

/** A stand-in for `codex login --device-auth`, driven by the test. */
function fakeCodexSpawn(script: {
    output?: string;
    /** Called before exit, so a "successful" login can leave a credential. */
    onRun?: (env: Record<string, string>) => void;
    exitCode?: number | null;
    exitAfterOutput?: boolean;
}): { spawn: ManagedAiAuthSpawn; kills: () => number; finish: () => void } {
    let killed = 0;
    let exit: ((code: number | null) => void) | null = null;
    const spawn: ManagedAiAuthSpawn = (input) => {
        const child: ManagedAiAuthChild = {
            onStdout: (listener) => {
                if (script.output !== undefined) queueMicrotask(() => listener(script.output!));
            },
            onExit: (listener) => {
                exit = listener;
                if (script.exitAfterOutput !== false) return;
                queueMicrotask(() => {
                    script.onRun?.(input.env);
                    listener(script.exitCode ?? 0);
                });
            },
            onError: () => undefined,
            kill: () => { killed += 1; },
        };
        return child;
    };
    return {
        spawn,
        kills: () => killed,
        finish: () => {
            script.onRun?.({});
            exit?.(script.exitCode ?? 0);
        },
    };
}

function store(over: Partial<Parameters<typeof createManagedAiAuthStore>[0]> = {}): ManagedAiAuthStore {
    return createManagedAiAuthStore({
        provider: { uid, gid },
        now: () => now,
        root,
        fs: recordingFs,
        fetchImpl: claudeTokenEndpoint({ ok: true, body: ACCEPTED_TOKENS }),
        deviceLoginStartTimeoutMs: 50,
        ...over,
    });
}

const start = (provider: 'claude' | 'codex', connectionVersion = 1) => ({
    action: 'login-start' as const,
    connectionId: CONNECTION,
    provider,
    connectionVersion,
    expiresAt: now + 600_000,
});

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'managed-ai-auth-'));
    // The boot stage makes the root; removing it here proves the store makes
    // its own rather than failing on a runtime that reached this without one.
    rmSync(root, { recursive: true, force: true });
    now = NOW;
    owned = [];
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('a claude login', () => {
    it('shouldHandBackAPasteCodeUrlAndKeepTheVerifierOffTheWire', async () => {
        const result = await store().run(start('claude'));
        expect(result.state).toBe('pending');
        expect(result.loginMethod).toBe('paste-code');
        expect(result.connectionVersion).toBeNull();
        const url = new URL(result.loginUrl!);
        expect(url.origin + url.pathname).toBe('https://claude.ai/oauth/authorize');
        // `code=true` is what makes the page show a code to paste at all.
        expect(url.searchParams.get('code')).toBe('true');
        expect(url.searchParams.get('scope')).toBe('user:profile user:inference');
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:54545/callback');
        // The reply is stored by the parent: a verifier in it would be a
        // verifier in the parent's database.
        expect(JSON.stringify(result)).not.toContain('code_verifier');
        expect(result).not.toHaveProperty('userCode');
    });

    it('shouldMakeTheHomeOwnedAndUnreadableToAnyoneElse', async () => {
        await store().run(start('claude'));
        for (const path of [root, connectionDir(), join(connectionDir(), 'claude')]) {
            expect(existsSync(path)).toBe(true);
        }
        expect(lstatSync(root).mode & 0o777).toBe(0o711);
        expect(lstatSync(connectionDir()).mode & 0o777).toBe(0o700);
        expect(lstatSync(join(connectionDir(), 'claude')).mode & 0o777).toBe(0o700);
        // The root is root's; the login below it belongs to the uid that runs
        // the provider, and nothing else on the machine may read it.
        expect(owned).toEqual([
            { path: root, uid: 0, gid: 0 },
            { path: connectionDir(), uid, gid },
            { path: join(connectionDir(), 'claude'), uid, gid },
        ]);
    });

    it('shouldRefuseASecondLoginWhileOneIsPending', async () => {
        const subject = store();
        await subject.run(start('claude'));
        await expect(subject.run(start('claude', 2)))
            .rejects.toThrow(MANAGED_AI_AUTH_FAILURES.inProgress);
    });

    it('shouldLetANewLoginStartOnceTheOldOneExpired', async () => {
        const subject = store();
        await subject.run({ ...start('claude'), expiresAt: now + 1_000 });
        now += 2_000;
        const restarted = await subject.run({ ...start('claude', 2), expiresAt: now + 600_000 });
        expect(restarted.state).toBe('pending');
    });

    it('shouldWriteTheCredentialClaudeCodeReadsAndReportAMaskedAccount', async () => {
        const subject = store();
        await subject.run(start('claude', 4));
        const done = await subject.run({
            action: 'login-complete', connectionId: CONNECTION, provider: 'claude', code: 'the-code',
        });
        expect(done).toEqual({
            state: 'connected', connectionVersion: 4, accountLabel: 'al***@example.test',
        });
        // Nothing secret came back with it.
        expect(JSON.stringify(done)).not.toContain('access-token-value');
        expect(JSON.stringify(done)).not.toContain('refresh-token-value');

        const credential = JSON.parse(readFileSync(claudeCredential(), 'utf8'));
        expect(credential.claudeAiOauth).toEqual({
            accessToken: 'access-token-value',
            refreshToken: 'refresh-token-value',
            expiresAt: now + 3_600_000,
            scopes: ['user:profile', 'user:inference'],
            subscriptionType: 'max',
        });
        expect(lstatSync(claudeCredential()).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(markerPath(), 'utf8')))
            .toEqual({ v: 1, provider: 'claude', connectionVersion: 4, accountLabel: 'al***@example.test' });
    });

    it('shouldAcceptTheCodeHashStateFormAndRefuseAForeignState', async () => {
        const subject = store();
        const pending = await subject.run(start('claude'));
        const state = new URL(pending.loginUrl!).searchParams.get('state')!;
        await expect(subject.run({
            action: 'login-complete', connectionId: CONNECTION, provider: 'claude', code: 'the-code#someone-else',
        })).rejects.toThrow(MANAGED_AI_AUTH_FAILURES.versionConflict);
        // The pending login survives a refused completion, so the real one
        // still works.
        const done = await subject.run({
            action: 'login-complete', connectionId: CONNECTION, provider: 'claude', code: `the-code#${state}`,
        });
        expect(done.state).toBe('connected');
    });

    it('shouldReportAFailedExchangeWithoutWritingAnything', async () => {
        const subject = store({ fetchImpl: claudeTokenEndpoint({ ok: false }) });
        await subject.run(start('claude'));
        const done = await subject.run({
            action: 'login-complete', connectionId: CONNECTION, provider: 'claude', code: 'the-code',
        });
        expect(done).toEqual({
            state: 'failed', connectionVersion: null, failureCode: MANAGED_AI_AUTH_FAILURES.exchangeFailed,
        });
        expect(existsSync(claudeCredential())).toBe(false);
        expect(existsSync(markerPath())).toBe(false);
        // And it stays reportable, so the parent can show "action required"
        // without having kept the reply it already lost.
        expect(await subject.run({ action: 'status', connectionId: CONNECTION, provider: 'claude' }))
            .toEqual({
                state: 'failed', connectionVersion: null, failureCode: MANAGED_AI_AUTH_FAILURES.exchangeFailed,
            });
    });

    it('shouldRefuseCompletingWithNoPendingLogin', async () => {
        await expect(store().run({
            action: 'login-complete', connectionId: CONNECTION, provider: 'claude', code: 'the-code',
        })).rejects.toThrow(MANAGED_AI_AUTH_FAILURES.noPending);
    });
});

describe('a codex login', () => {
    const DEVICE_OUTPUT = 'Open https://auth.openai.com/device and enter code ABCD-1234\n';

    const writeCodexAuth = () => {
        mkdirSync(join(connectionDir(), 'codex'), { recursive: true });
        // `email` in the id token is what names the account; the payload is
        // unsigned here because nothing in this path verifies it — it is a
        // display label, not an authorisation.
        const payload = Buffer.from(JSON.stringify({ email: 'bob@example.test' })).toString('base64url');
        writeFileSync(codexCredential(), JSON.stringify({
            tokens: { id_token: `header.${payload}.signature`, access_token: 'x' },
        }));
    };

    it('shouldReturnTheVerificationUrlAndUserCode', async () => {
        const fake = fakeCodexSpawn({ output: DEVICE_OUTPUT, exitAfterOutput: true });
        const result = await store({ spawn: fake.spawn }).run(start('codex'));
        expect(result).toMatchObject({
            state: 'pending',
            loginMethod: 'device-code',
            loginUrl: 'https://auth.openai.com/device',
            userCode: 'ABCD-1234',
            connectionVersion: null,
        });
    });

    it('shouldRunAsTheProviderUidInThisConnectionsHome', async () => {
        let seen: { env: Record<string, string>; uid: number; cwd: string } | null = null;
        const spawn: ManagedAiAuthSpawn = (input) => {
            seen = { env: input.env, uid: input.uid, cwd: input.cwd };
            return {
                onStdout: (listener) => queueMicrotask(() => listener(DEVICE_OUTPUT)),
                onExit: () => undefined,
                onError: () => undefined,
                kill: () => undefined,
            };
        };
        await store({ spawn }).run(start('codex'));
        expect(seen!.uid).toBe(uid);
        expect(seen!.env.CODEX_HOME).toBe(join(connectionDir(), 'codex'));
        expect(seen!.env.HOME).toBe(connectionDir());
        // Nothing inherited: the environment is built from nothing, like every
        // other managed provider environment.
        expect(Object.keys(seen!.env).sort()).toEqual(['CODEX_HOME', 'HOME', 'PATH']);
    });

    it('shouldBecomeConnectedOnceTheDeviceFlowSucceeded', async () => {
        const fake = fakeCodexSpawn({
            output: DEVICE_OUTPUT, exitAfterOutput: true, onRun: writeCodexAuth, exitCode: 0,
        });
        const subject = store({ spawn: fake.spawn });
        await subject.run(start('codex', 7));
        // Still running: reading it is not inventing an answer.
        expect(await subject.run({ action: 'login-complete', connectionId: CONNECTION, provider: 'codex' }))
            .toMatchObject({ state: 'pending' });
        fake.finish();
        const done = await subject.run({
            action: 'login-complete', connectionId: CONNECTION, provider: 'codex',
        });
        expect(done).toEqual({
            state: 'connected', connectionVersion: 7, accountLabel: 'bo***@example.test',
        });
        expect(JSON.parse(readFileSync(markerPath(), 'utf8')).connectionVersion).toBe(7);
    });

    it('shouldFailWhenTheDeviceProcessExitedNonZero', async () => {
        const fake = fakeCodexSpawn({ output: DEVICE_OUTPUT, exitAfterOutput: true, exitCode: 3 });
        const subject = store({ spawn: fake.spawn });
        await subject.run(start('codex'));
        fake.finish();
        expect(await subject.run({ action: 'login-complete', connectionId: CONNECTION, provider: 'codex' }))
            .toEqual({
                state: 'failed', connectionVersion: null, failureCode: MANAGED_AI_AUTH_FAILURES.exchangeFailed,
            });
        expect(existsSync(markerPath())).toBe(false);
    });

    it('shouldRefuseAndKillADeviceFlowThatPrintsNoUrl', async () => {
        const fake = fakeCodexSpawn({ exitAfterOutput: true });
        await expect(store({ spawn: fake.spawn }).run(start('codex')))
            .rejects.toThrow(MANAGED_AI_AUTH_FAILURES.providerUnavailable);
        expect(fake.kills()).toBe(1);
    });

    it('shouldRefuseWhenTheProviderCannotBeStartedAtAll', async () => {
        const spawn: ManagedAiAuthSpawn = () => { throw new Error('ENOENT'); };
        await expect(store({ spawn }).run(start('codex')))
            .rejects.toThrow(MANAGED_AI_AUTH_FAILURES.providerUnavailable);
    });
});

describe('cancelling, logging out and reading state', () => {
    const complete = async (subject: ManagedAiAuthStore, version: number) => {
        await subject.run(start('claude', version));
        return subject.run({
            action: 'login-complete', connectionId: CONNECTION, provider: 'claude', code: 'the-code',
        });
    };

    it('shouldReportAbsentBeforeAnythingHasHappened', async () => {
        expect(await store().run({ action: 'status', connectionId: CONNECTION, provider: 'claude' }))
            .toEqual({ state: 'absent', connectionVersion: null });
    });

    it('shouldLeaveAnExistingCredentialAloneWhenALoginIsCancelled', async () => {
        const subject = store();
        await complete(subject, 2);
        await subject.run(start('claude', 3));
        const cancelled = await subject.run({
            action: 'login-cancel', connectionId: CONNECTION, provider: 'claude',
        });
        // The connection is what it was: a cancelled re-login revokes nothing.
        expect(cancelled).toEqual({
            state: 'connected', connectionVersion: 2, accountLabel: 'al***@example.test',
        });
        expect(existsSync(claudeCredential())).toBe(true);
    });

    it('shouldRemoveTheWholeConnectionOnLogout', async () => {
        const subject = store();
        await complete(subject, 2);
        expect(await subject.run({
            action: 'logout', connectionId: CONNECTION, provider: 'claude', connectionVersion: 3,
        })).toEqual({ state: 'absent', connectionVersion: 3 });
        expect(existsSync(connectionDir())).toBe(false);
        // The root stays: it is the boot stage's, and other connections live
        // in it.
        expect(existsSync(root)).toBe(true);
        expect(await subject.run({ action: 'status', connectionId: CONNECTION, provider: 'claude' }))
            .toEqual({ state: 'absent', connectionVersion: null });
    });

    it('shouldRefuseALoginThatWouldNotAdvanceTheRecordedVersion', async () => {
        const subject = store();
        await complete(subject, 5);
        await expect(subject.run(start('claude', 5)))
            .rejects.toThrow(MANAGED_AI_AUTH_FAILURES.versionConflict);
        await expect(subject.run(start('claude', 4)))
            .rejects.toThrow(MANAGED_AI_AUTH_FAILURES.versionConflict);
        expect((await subject.run(start('claude', 6))).state).toBe('pending');
    });

    it('shouldReportNothingForTheOtherProvidersCredential', async () => {
        const subject = store();
        await complete(subject, 2);
        // The same connection id, the other provider: there is no login there,
        // and reporting the claude one would tell the parent it may dispatch a
        // codex run against it.
        expect(await subject.run({ action: 'status', connectionId: CONNECTION, provider: 'codex' }))
            .toEqual({ state: 'absent', connectionVersion: null });
    });

    it('shouldRefuseToWriteThroughASymlinkedConnectionDirectory', async () => {
        const elsewhere = mkdtempSync(join(tmpdir(), 'managed-ai-auth-elsewhere-'));
        mkdirSync(root, { recursive: true, mode: 0o711 });
        symlinkSync(elsewhere, connectionDir());
        try {
            await expect(store().run(start('claude')))
                .rejects.toThrow(MANAGED_AI_AUTH_FAILURES.providerUnavailable);
            expect(existsSync(join(elsewhere, 'claude'))).toBe(false);
        } finally {
            rmSync(elsewhere, { recursive: true, force: true });
        }
    });

    it('shouldRefuseToRemoveASymlinkedConnectionDirectoryOnLogout', async () => {
        const elsewhere = mkdtempSync(join(tmpdir(), 'managed-ai-auth-elsewhere-'));
        writeFileSync(join(elsewhere, 'not-ours'), 'keep me');
        mkdirSync(root, { recursive: true, mode: 0o711 });
        symlinkSync(elsewhere, connectionDir());
        try {
            await expect(store().run({
                action: 'logout', connectionId: CONNECTION, provider: 'claude', connectionVersion: 2,
            })).rejects.toThrow(MANAGED_AI_AUTH_FAILURES.providerUnavailable);
            expect(existsSync(join(elsewhere, 'not-ours'))).toBe(true);
        } finally {
            rmSync(elsewhere, { recursive: true, force: true });
        }
    });

    it('shouldRunOneActionPerConnectionAtATime', async () => {
        // Two starts issued together: without the chain both see no pending
        // login and both build a home, and the second's URL is the one the
        // user gets while the first's verifier is what is remembered.
        const subject = store();
        const outcomes = await Promise.allSettled([
            subject.run(start('claude', 1)),
            subject.run(start('claude', 2)),
        ]);
        expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
        expect((outcomes[1] as PromiseRejectedResult).reason)
            .toBeInstanceOf(ManagedAiAuthError);
    });
});

describe('reading what the provider printed', () => {
    it.each([
        ['a dashed code', 'Visit https://auth.openai.com/device and enter WXYZ-7788', 'WXYZ-7788'],
        ['a code named on the line', 'go to https://example.test/x\nYour code: AB12CD', 'AB12CD'],
    ])('shouldFind(%s)', (_name, text, code) => {
        expect(parseCodexDeviceLogin(text)?.userCode).toBe(code);
    });

    it('shouldReturnNothingUntilThereIsAUrl', () => {
        expect(parseCodexDeviceLogin('starting device authorization...')).toBeNull();
    });

    it('shouldMaskAnAccountRatherThanShowIt', () => {
        expect(maskAccountLabel('alice@example.test')).toBe('al***@example.test');
        expect(maskAccountLabel('a@b.test')).toBe('a***@b.test');
        expect(maskAccountLabel(undefined)).toBeNull();
        expect(maskAccountLabel('not-an-email')).toBeNull();
    });

    it('shouldTakeTheCodexAccountFromItsIdTokenOrSayNothing', () => {
        const payload = Buffer.from(JSON.stringify({ email: 'bob@example.test' })).toString('base64url');
        expect(codexAccountLabel(JSON.stringify({ tokens: { id_token: `a.${payload}.b` } })))
            .toBe('bo***@example.test');
        expect(codexAccountLabel(JSON.stringify({ tokens: {} }))).toBeNull();
        expect(codexAccountLabel('not json')).toBeNull();
        expect(codexAccountLabel(null)).toBeNull();
    });
});
