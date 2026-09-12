import { describe, expect, it } from 'vitest';
import {
    getAvailableModels,
    getAvailablePermissionModes,
    getCodexModelModes,
    getClaudeModelModes,
    getClaudePermissionModes,
    getDefaultEffortKey,
    getDefaultModelKey,
    getDefaultPermissionModeKey,
    mapMetadataOptions,
    resolveCurrentOption,
    resolveSessionOption,
} from './modelModeOptions';

const translate = (key: string) => `tr:${key}`;

describe('modelModeOptions', () => {
    it('maps metadata option shape into mode options', () => {
        expect(mapMetadataOptions([
            { code: 'm1', value: 'Model One', description: 'Primary model' },
            { code: 'm2', value: 'Model Two' },
        ])).toEqual([
            { key: 'm1', name: 'Model One', description: 'Primary model' },
            { key: 'm2', name: 'Model Two', description: null },
        ]);
    });

    it('builds claude permission fallbacks with translated names', () => {
        const modes = getClaudePermissionModes(translate);
        expect(modes.map((mode) => mode.key)).toEqual(['default', 'plan', 'dontAsk', 'acceptEdits', 'bypassPermissions']);
        expect(modes[0].name).toBe('tr:agentInput.permissionMode.default');
    });

    it('builds codex model fallbacks', () => {
        const models = getCodexModelModes();
        expect(models.map((model) => model.key)).toEqual([
            'default',
            'gpt-5.5',
            'gpt-5.4',
            'gpt-5.3-codex',
            'gpt-5.2-codex',
            'gpt-5.1-codex-max',
            'gpt-5.2',
            'gpt-5.1-codex-mini',
        ]);
        expect(models[0].name).toBe('default model');
        expect(models[1].name).toBe('gpt-5.5');
    });

    it('builds claude model fallbacks', () => {
        const models = getClaudeModelModes();
        expect(models.map((model) => model.key)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
        expect(models[1].name).toBe('opus 4.8');
    });

    it('uses code defaults for agent defaults', () => {
        expect(getDefaultPermissionModeKey('claude')).toBe('bypassPermissions');
        expect(getDefaultModelKey('claude')).toBe('opus');
        expect(getDefaultEffortKey('claude')).toBe('medium');
        expect(getDefaultPermissionModeKey('codex')).toBe('yolo');
        expect(getDefaultModelKey('codex')).toBe('gpt-5.5');
        expect(getDefaultEffortKey('codex')).toBe('medium');
    });

    it('prefers metadata models over hardcoded fallbacks', () => {
        const models = getAvailableModels('gemini', {
            models: [
                { code: 'custom-gemini', value: 'Gemini Custom', description: 'From metadata' },
            ],
        } as any, translate);

        expect(models).toEqual([
            { key: 'custom-gemini', name: 'Gemini Custom', description: 'From metadata' },
        ]);
    });

    it('adds codex default model option when metadata models are present', () => {
        const models = getAvailableModels('codex', {
            models: [
                { code: 'gpt-5.4', value: 'gpt-5.4', description: 'Latest' },
            ],
        } as any, translate);

        expect(models).toEqual([
            { key: 'default', name: 'default model', description: null },
            { key: 'gpt-5.4', name: 'gpt-5.4', description: 'Latest' },
        ]);
    });

    it('keeps codex permission modes hardcoded even when metadata modes exist', () => {
        const modes = getAvailablePermissionModes('codex', {
            operatingModes: [{ code: 'metadata-only', value: 'Metadata Mode', description: null }],
        } as any, translate);

        expect(modes.map((mode) => mode.key)).toEqual(['default', 'read-only', 'safe-yolo', 'yolo']);
    });

    it('applies hacks to metadata-provided operating modes', () => {
        const modes = getAvailablePermissionModes('gemini', {
            operatingModes: [
                { code: 'build', value: 'build, build', description: 'Do build steps' },
                { code: 'plan', value: 'plan/plan', description: 'Plan first' },
            ],
        } as any, translate);

        expect(modes).toEqual([
            { key: 'build', name: 'Build', description: 'Do build steps' },
            { key: 'plan', name: 'Plan', description: 'Plan first' },
        ]);
    });

    it('resolves the first matching preferred key', () => {
        const options = [
            { key: 'a', name: 'A' },
            { key: 'b', name: 'B' },
        ];

        expect(resolveCurrentOption(options, ['missing', 'b', 'a'])).toEqual({ key: 'b', name: 'B' });
        expect(resolveCurrentOption(options, ['missing'])).toBeNull();
    });
});

describe('resolveSessionOption', () => {
    const models = [
        { key: 'default', name: 'default model' },
        { key: 'opus', name: 'opus' },
        { key: 'sonnet', name: 'sonnet' },
        { key: 'haiku', name: 'haiku' },
    ];
    const efforts = [
        { key: 'low', name: 'low' },
        { key: 'medium', name: 'medium' },
        { key: 'high', name: 'high' },
        { key: 'max', name: 'max' },
    ];

    // The regression this ordering exists for. getCodeAgentDefaults('claude')
    // always yields opus/medium, so an agent default listed before the session
    // pin makes the pin unreachable and the session renders the wrong model.
    it('prefers the session pin over the agent default when this device has no choice', () => {
        expect(resolveSessionOption(models, {
            local: null,
            sessionPin: 'sonnet',
            agentDefault: 'opus',
        })).toEqual({ key: 'sonnet', name: 'sonnet' });

        expect(resolveSessionOption(efforts, {
            local: null,
            sessionPin: 'max',
            agentDefault: 'medium',
        })).toEqual({ key: 'max', name: 'max' });
    });

    it("keeps this device's explicit choice above both", () => {
        expect(resolveSessionOption(models, {
            local: 'haiku',
            sessionPin: 'sonnet',
            agentDefault: 'opus',
        })).toEqual({ key: 'haiku', name: 'haiku' });
    });

    it('falls back to the agent default for a session with no pin', () => {
        expect(resolveSessionOption(models, {
            local: null,
            sessionPin: null,
            agentDefault: 'opus',
        })).toEqual({ key: 'opus', name: 'opus' });
    });

    // A pin this build does not know about must not strand the picker on null.
    it('skips a pin that is not in this build option list', () => {
        expect(resolveSessionOption(models, {
            local: null,
            sessionPin: 'claude-future-9',
            agentDefault: 'opus',
        })).toEqual({ key: 'opus', name: 'opus' });
    });

    it('returns null when nothing resolves', () => {
        expect(resolveSessionOption(models, { local: null, sessionPin: null, agentDefault: null })).toBeNull();
    });
});
