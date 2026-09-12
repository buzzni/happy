import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sdkQuery = vi.hoisted(() => vi.fn(() => ({ mocked: true })));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: sdkQuery,
}));

import { query } from './query';

describe('query adapter', () => {
    beforeEach(() => {
        sdkQuery.mockClear();
    });

    it('forwards the built-in tool allowance, including the empty list that disables them', () => {
        query({ prompt: 'continue', options: { tools: [] } });
        // 빈 배열은 "전부 끈다" 는 뜻이다. 여기서 흘리면 관리 실행의 도구 경계가
        // SDK 까지 도달하지 못한다.
        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ tools: [] }),
        }));

        sdkQuery.mockClear();
        query({ prompt: 'continue', options: { tools: ['Read'] } });
        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ tools: ['Read'] }),
        }));
    });

    it('forwards prompt suggestion enablement to the Claude Agent SDK', () => {
        query({
            prompt: 'continue',
            options: { promptSuggestions: true },
        });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({
                promptSuggestions: true,
            }),
        }));
    });

    it('enables partial assistant message streaming so the app can render tokens before a block completes', () => {
        query({ prompt: 'continue', options: {} });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ includePartialMessages: true }),
        }));
    });

    it('forwards additional directories to the Claude Agent SDK for new and resumed queries', () => {
        for (const resume of [undefined, 'claude-session-id']) {
            query({
                prompt: 'continue',
                options: {
                    additionalDirectories: ['/repo/frontend', '/repo/backend'],
                    resume,
                },
            });
        }

        expect(sdkQuery).toHaveBeenNthCalledWith(1, expect.objectContaining({
            options: expect.objectContaining({
                additionalDirectories: ['/repo/frontend', '/repo/backend'],
                resume: undefined,
            }),
        }));
        expect(sdkQuery).toHaveBeenNthCalledWith(2, expect.objectContaining({
            options: expect.objectContaining({
                additionalDirectories: ['/repo/frontend', '/repo/backend'],
                resume: 'claude-session-id',
            }),
        }));
    });

    it('forwards fail-closed sandbox settings to the Claude Agent SDK', () => {
        const sandbox = {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            filesystem: { denyWrite: ['/project/**/.env*'] },
        };

        query({ prompt: 'edit', options: { sandbox } });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ sandbox }),
        }));
    });

    it('inlines hook settings when sandbox settings must be merged by the SDK', () => {
        const directory = mkdtempSync(join(tmpdir(), 'happy-query-settings-'));
        const settingsPath = join(directory, 'settings.json');
        const hooks = { hooks: { SessionStart: [{ matcher: '*' }] } };
        writeFileSync(settingsPath, JSON.stringify(hooks));
        const sandbox = { enabled: true, failIfUnavailable: true };
        try {
            query({ prompt: 'edit', options: { settingsPath, sandbox } });

            const settings = (sdkQuery.mock.calls as unknown as Array<Array<any>>)[0][0].options.settings;
            expect(typeof settings).toBe('string');
            expect(JSON.parse(settings as string)).toEqual(hooks);
            expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
                options: expect.objectContaining({ sandbox }),
            }));
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    // SDK 의 sandbox 는 주로 Bash 실행 경계다. Read/Edit 같은 도구는 CLI 의 권한
    // 규칙으로 막아야 하므로, 공유 머신에서는 두 층을 함께 내려보낸다.
    it('merges deny rules into the inlined settings so tool reads are blocked too', () => {
        const directory = mkdtempSync(join(tmpdir(), 'happy-query-deny-'));
        const settingsPath = join(directory, 'settings.json');
        const hooks = { hooks: { SessionStart: [{ matcher: '*' }] } };
        writeFileSync(settingsPath, JSON.stringify(hooks));
        try {
            query({
                prompt: 'edit',
                options: {
                    settingsPath,
                    sandbox: { enabled: true, failIfUnavailable: true },
                    permissionsDeny: ['Read(/root/.happy/**)', 'Edit(/root/.happy/**)'],
                },
            });

            const settings = (sdkQuery.mock.calls as unknown as Array<Array<any>>)[0][0].options.settings;
            const parsed = JSON.parse(settings as string);
            expect(parsed.hooks).toEqual(hooks.hooks);
            expect(parsed.permissions.deny).toEqual([
                'Read(/root/.happy/**)',
                'Edit(/root/.happy/**)',
            ]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    // 규칙만 있고 sandbox 가 없어도 규칙은 반드시 내려가야 한다 — 경로로 넘기면
    // SDK 가 그 파일을 읽고 우리 규칙은 사라진다.
    it('inlines settings for deny rules even without sandbox settings', () => {
        const directory = mkdtempSync(join(tmpdir(), 'happy-query-deny-only-'));
        const settingsPath = join(directory, 'settings.json');
        writeFileSync(settingsPath, JSON.stringify({}));
        try {
            query({
                prompt: 'edit',
                options: { settingsPath, permissionsDeny: ['Read(/root/.happy/**)'] },
            });

            const settings = (sdkQuery.mock.calls as unknown as Array<Array<any>>)[0][0].options.settings;
            expect(JSON.parse(settings as string).permissions.deny).toEqual(['Read(/root/.happy/**)']);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('keeps existing deny rules from the settings file', () => {
        const directory = mkdtempSync(join(tmpdir(), 'happy-query-deny-merge-'));
        const settingsPath = join(directory, 'settings.json');
        writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));
        try {
            query({
                prompt: 'edit',
                options: { settingsPath, permissionsDeny: ['Read(/root/.happy/**)'] },
            });

            const settings = (sdkQuery.mock.calls as unknown as Array<Array<any>>)[0][0].options.settings;
            expect(JSON.parse(settings as string).permissions.deny).toEqual([
                'Bash(rm:*)',
                'Read(/root/.happy/**)',
            ]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
