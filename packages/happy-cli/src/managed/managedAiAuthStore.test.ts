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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    codexAccountLabel,
    createManagedAiAuthStore,
    defaultManagedAiAuthFs,
    MANAGED_AI_AUTH_API_KEY_FILE,
    MANAGED_AI_AUTH_FAILURES,
    ManagedAiAuthError,
    maskAccountLabel,
    parseCodexDeviceLogin,
    readManagedAiAuthApiKey,
    type ManagedAiAuthChild,
    type ManagedAiAuthFs,
    type ManagedAiAuthSpawn,
    type ManagedAiAuthStore,
} from '@/managed/managedAiAuthStore';
import {
    MANAGED_AI_AUTH_MARKER_FILE,
    type ManagedAiAuthProvider,
} from '@/managed/managedAiAuth';
import { logger } from '@/ui/logger';

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
            state: 'connected', connectionVersion: 4, credentialKind: 'oauth',
            accountLabel: 'al***@example.test',
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
            .toEqual({
                v: 1, provider: 'claude', connectionVersion: 4, credentialKind: 'oauth',
                accountLabel: 'al***@example.test',
            });
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
            state: 'connected', connectionVersion: 7, credentialKind: 'oauth',
            accountLabel: 'bo***@example.test',
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

describe('a glm connection is key-only', () => {
    it('shouldRefuseALoginStartForGlmEvenWhenCalledDirectly', async () => {
        // The parser already refuses it; this is the store's own refusal, so a
        // caller that bypasses the parser cannot start a codex device flow
        // under a glm connection.
        await expect(store().run({
            action: 'login-start', connectionId: CONNECTION, provider: 'glm', connectionVersion: 1, expiresAt: NOW + 1000,
        })).rejects.toThrow(MANAGED_AI_AUTH_FAILURES.providerUnavailable);
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
            state: 'connected', connectionVersion: 2, credentialKind: 'oauth',
            accountLabel: 'al***@example.test',
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

    it('shouldRefuseALogoutThatNamesAVersionOlderThanTheOneOnDisk', async () => {
        /*
         * A logout replayed after a newer login — a retried socket frame, or a
         * token captured inside its window — would otherwise remove the
         * credential the newer login just wrote.
         */
        const subject = store();
        await complete(subject, 5);
        await expect(subject.run({
            action: 'logout', connectionId: CONNECTION, provider: 'claude', connectionVersion: 4,
        })).rejects.toThrow(MANAGED_AI_AUTH_FAILURES.versionConflict);
        expect(existsSync(claudeCredential())).toBe(true);
        // The version the parent recorded the login at is still a logout of
        // that login; only an older one is a replay.
        expect(await subject.run({
            action: 'logout', connectionId: CONNECTION, provider: 'claude', connectionVersion: 5,
        })).toEqual({ state: 'absent', connectionVersion: 5 });
        expect(existsSync(connectionDir())).toBe(false);
    });

    it('shouldDropAnOversizedAccountLabelRatherThanRelayIt', async () => {
        // The marker is owned by the provider uid, so the provider process can
        // rewrite it. The label is display text, and it is bounded here so a
        // rewritten one cannot carry a page into the parent's row.
        const subject = store();
        await complete(subject, 2);
        const marker = JSON.parse(readFileSync(markerPath(), 'utf8')) as Record<string, unknown>;
        writeFileSync(markerPath(), JSON.stringify({ ...marker, accountLabel: 'x'.repeat(300) }));
        const reported = await subject.run({ action: 'status', connectionId: CONNECTION, provider: 'claude' });
        expect(reported).toMatchObject({ state: 'connected', connectionVersion: 2 });
        expect(reported).not.toHaveProperty('accountLabel');
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

    it('shouldPreferTheVendorsUrlOverABannerThatCameFirst', () => {
        // Codex may print a docs or telemetry link before the verification
        // URL. The first `https://` is then a page the login can never finish
        // on, and the pending state would sit there until it expired.
        const text = 'See https://developers.openai.com/codex/cli for help\n'
            + 'Open https://auth.openai.com/codex/device and enter code: WXYZ-7788';
        expect(parseCodexDeviceLogin(text)).toEqual({
            loginUrl: 'https://auth.openai.com/codex/device', userCode: 'WXYZ-7788',
        });
        // With no vendor host anywhere the first URL still stands — the
        // wording belongs to a CLI this package does not control.
        expect(parseCodexDeviceLogin('go to https://example.test/x\nYour code: AB12CD')?.loginUrl)
            .toBe('https://example.test/x');
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

describe('a registered api key', () => {
    const KEY = 'sk-managed-key-0123456789';
    const providerHome = (provider: ManagedAiAuthProvider) => join(connectionDir(), provider);
    const keyFile = (provider: ManagedAiAuthProvider) =>
        join(providerHome(provider), MANAGED_AI_AUTH_API_KEY_FILE);

    const setKey = (
        provider: ManagedAiAuthProvider, connectionVersion = 1, apiKey = KEY,
    ) => ({
        action: 'set-key' as const, connectionId: CONNECTION, provider, connectionVersion, apiKey,
    });

    const login = async (subject: ManagedAiAuthStore, version: number) => {
        await subject.run(start('claude', version));
        return subject.run({
            action: 'login-complete', connectionId: CONNECTION, provider: 'claude', code: 'the-code',
        });
    };

    it.each(['claude', 'codex', 'glm'] as const)('shouldRegisterAKeyFor(%s)', async (provider) => {
        const subject = store();
        const done = await subject.run(setKey(provider, 3));
        // No account label, ever: there is nothing in a key to name an account
        // with, and a prefix of it is a prefix of the secret.
        expect(done).toEqual({ state: 'connected', connectionVersion: 3, credentialKind: 'api-key' });

        expect(JSON.parse(readFileSync(keyFile(provider), 'utf8')))
            .toEqual({ v: 1, provider, apiKey: KEY });
        expect(lstatSync(keyFile(provider)).mode & 0o777).toBe(0o600);
        expect(lstatSync(providerHome(provider)).mode & 0o777).toBe(0o700);
        expect(owned).toContainEqual({ path: providerHome(provider), uid, gid });
        expect(JSON.parse(readFileSync(markerPath(), 'utf8')))
            .toEqual({ v: 1, provider, connectionVersion: 3, credentialKind: 'api-key' });

        expect(await subject.run({ action: 'status', connectionId: CONNECTION, provider }))
            .toEqual({ state: 'connected', connectionVersion: 3, credentialKind: 'api-key' });
        expect(readManagedAiAuthApiKey(providerHome(provider), defaultManagedAiAuthFs.readFile))
            .toBe(KEY);
    });

    it('shouldRefuseAKeyWhileALoginIsPending', async () => {
        const subject = store();
        await subject.run(start('claude'));
        await expect(subject.run(setKey('claude', 2)))
            .rejects.toThrow(MANAGED_AI_AUTH_FAILURES.inProgress);
        expect(existsSync(keyFile('claude'))).toBe(false);
    });

    it('shouldRefuseAKeyThatWouldNotAdvanceTheRecordedVersion', async () => {
        const subject = store();
        await subject.run(setKey('claude', 5));
        await expect(subject.run(setKey('claude', 5)))
            .rejects.toThrow(MANAGED_AI_AUTH_FAILURES.versionConflict);
        await expect(subject.run(setKey('claude', 4)))
            .rejects.toThrow(MANAGED_AI_AUTH_FAILURES.versionConflict);
        expect((await subject.run(setKey('claude', 6))).connectionVersion).toBe(6);
    });

    it('shouldRefuseALoginThatWouldNotAdvanceTheVersionAKeyRecorded', async () => {
        const subject = store();
        await subject.run(setKey('claude', 5));
        await expect(subject.run(start('claude', 5)))
            .rejects.toThrow(MANAGED_AI_AUTH_FAILURES.versionConflict);
    });

    it('shouldLeaveOnlyTheKeyWhenALoginIsReplacedByOne', async () => {
        const subject = store();
        await login(subject, 2);
        expect(existsSync(claudeCredential())).toBe(true);
        await subject.run(setKey('claude', 3));
        // One connection holds one credential: the login it replaced is gone,
        // not left beside it for whichever reader looks first.
        expect(existsSync(claudeCredential())).toBe(false);
        expect(existsSync(keyFile('claude'))).toBe(true);
        expect(await subject.run({ action: 'status', connectionId: CONNECTION, provider: 'claude' }))
            .toEqual({ state: 'connected', connectionVersion: 3, credentialKind: 'api-key' });
    });

    it('shouldLeaveOnlyTheLoginWhenAKeyIsReplacedByOne', async () => {
        const subject = store();
        await subject.run(setKey('claude', 1));
        const done = await login(subject, 2);
        expect(existsSync(keyFile('claude'))).toBe(false);
        expect(existsSync(claudeCredential())).toBe(true);
        expect(done).toEqual({
            state: 'connected', connectionVersion: 2, credentialKind: 'oauth',
            accountLabel: 'al***@example.test',
        });
    });

    it('shouldDropACodexLoginWhenAKeyReplacesIt', async () => {
        const subject = store();
        mkdirSync(join(connectionDir(), 'codex'), { recursive: true });
        writeFileSync(codexCredential(), JSON.stringify({ tokens: { access_token: 'x' } }));
        await subject.run(setKey('codex', 2));
        expect(existsSync(codexCredential())).toBe(false);
        expect(existsSync(keyFile('codex'))).toBe(true);
    });

    it('shouldNotReportConnectedWhenTheFileDoesNotMatchTheMarkersKind', async () => {
        const subject = store();
        await subject.run(setKey('claude', 2));
        // A login file left under a marker that says key: it is whatever was
        // put there, and spending it would spend an account the parent never
        // recorded. The key itself is gone, so the only file present is the
        // one of the wrong kind.
        rmSync(keyFile('claude'));
        writeFileSync(claudeCredential(), '{}');
        expect(await subject.run({ action: 'status', connectionId: CONNECTION, provider: 'claude' }))
            .toEqual({ state: 'absent', connectionVersion: null });
    });

    it('shouldHoldTheConnectionOnlyForTheKindTheMarkerRecords', async () => {
        const subject = store();
        await subject.run(setKey('claude', 4));
        /*
         * A login file put there **after** the key was registered.
         *
         * The provider uid owns this directory and can write anything into it,
         * and an upgrade can leave one behind. Without it this test would pass
         * on the file check alone — the marker's kind would never be consulted
         * — so the file that makes the two answers differ is planted on
         * purpose.
         */
        writeFileSync(claudeCredential(), '{}');
        const held = (over: Partial<Parameters<ManagedAiAuthStore['holdsConnection']>[0]>) =>
            subject.holdsConnection({
                connectionId: CONNECTION, provider: 'claude', connectionVersion: 4,
                credentialKind: 'api-key', ...over,
            });
        expect(held({})).toBe(true);
        // A run admitted on a subscription must not be served by the key that
        // replaced it, even though both files are sitting in this connection.
        expect(held({ credentialKind: 'oauth' })).toBe(false);
        expect(held({ connectionVersion: 5 })).toBe(false);
        expect(held({ provider: 'codex' })).toBe(false);
    });

    it('shouldNotHoldAnApiKeyRunAgainstALogin', async () => {
        const subject = store();
        await login(subject, 2);
        const held = (credentialKind: 'oauth' | 'api-key') => subject.holdsConnection({
            connectionId: CONNECTION, provider: 'claude', connectionVersion: 2, credentialKind,
        });
        expect(held('oauth')).toBe(true);
        expect(held('api-key')).toBe(false);
    });

    it('shouldTreatAMarkerWrittenBeforeKeysExistedAsALogin', async () => {
        const subject = store();
        await login(subject, 2);
        const marker = JSON.parse(readFileSync(markerPath(), 'utf8'));
        delete marker.credentialKind;
        writeFileSync(markerPath(), JSON.stringify(marker));
        expect(await subject.run({ action: 'status', connectionId: CONNECTION, provider: 'claude' }))
            .toMatchObject({ state: 'connected', credentialKind: 'oauth' });
        expect(subject.holdsConnection({
            connectionId: CONNECTION, provider: 'claude', connectionVersion: 2, credentialKind: 'oauth',
        })).toBe(true);
    });

    it('shouldRemoveARegisteredKeyOnLogout', async () => {
        const subject = store();
        await subject.run(setKey('glm', 2));
        expect(await subject.run({
            action: 'logout', connectionId: CONNECTION, provider: 'glm', connectionVersion: 3,
        })).toEqual({ state: 'absent', connectionVersion: 3 });
        expect(existsSync(connectionDir())).toBe(false);
    });

    it('shouldKeepTheKeyOutOfEveryReplyAndEveryLogLine', async () => {
        const written: string[] = [];
        const record = (message: string, ...args: unknown[]) => {
            written.push([message, ...args.map((arg) => JSON.stringify(arg) ?? '')].join(' '));
        };
        const spies = (['debug', 'info', 'infoDeveloper', 'warn'] as const)
            .map((level) => vi.spyOn(logger, level).mockImplementation(record));
        try {
            const subject = store();
            const replies = [
                await subject.run(setKey('claude', 2)),
                await subject.run({ action: 'status', connectionId: CONNECTION, provider: 'claude' }),
                await subject.run({
                    action: 'logout', connectionId: CONNECTION, provider: 'claude', connectionVersion: 3,
                }),
            ];
            expect(JSON.stringify(replies)).not.toContain(KEY);
            expect(written.join('\n')).not.toContain(KEY);
        } finally {
            for (const spy of spies) spy.mockRestore();
        }
    });
});

describe('reading a registered key back, as the child does', () => {
    let home: string;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'managed-ai-auth-home-'));
    });

    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
    });

    const write = (contents: string) => {
        writeFileSync(join(home, MANAGED_AI_AUTH_API_KEY_FILE), contents);
    };

    it('shouldReturnTheKeyItWasGiven', () => {
        write(JSON.stringify({ v: 1, provider: 'glm', apiKey: 'sk-a-real-looking-key' }));
        expect(readManagedAiAuthApiKey(home, defaultManagedAiAuthFs.readFile))
            .toBe('sk-a-real-looking-key');
    });

    it('shouldSurviveAReaderThatThrowsOnAMissingFile', () => {
        // `readFileSync` is the production reader and it throws; a reader that
        // propagated would turn "no key" into a crash on an unrelated path.
        expect(readManagedAiAuthApiKey(home, (path) => readFileSync(path, 'utf8'))).toBeNull();
    });

    it.each([
        ['not json at all', 'nonsense'],
        ['a version this runtime does not know', JSON.stringify({ v: 2, apiKey: 'sk-abcdefgh' })],
        ['no key in it', JSON.stringify({ v: 1, provider: 'glm' })],
        ['a key the rpc would itself refuse', JSON.stringify({ v: 1, apiKey: 'short' })],
        ['a key with whitespace in it', JSON.stringify({ v: 1, apiKey: 'sk-a b c d e f' })],
    ])('shouldRefuseToReadBack(%s)', (_name, contents) => {
        write(contents);
        expect(readManagedAiAuthApiKey(home, defaultManagedAiAuthFs.readFile)).toBeNull();
    });
});
