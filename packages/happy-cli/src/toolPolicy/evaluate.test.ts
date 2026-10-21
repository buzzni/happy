import { describe, expect, it } from 'vitest';
import { evaluateToolCall, requiredCuaTarget, verbOf, type PolicyCallInput, type PolicyGrantView } from './evaluate';
import { ABSENT_MACHINE_POLICY, parseMachinePolicy, type AppIdentity, type MachinePolicy } from './rules';

const NO_GRANTS: PolicyGrantView = { hasGrant: () => false, recentlyDenied: () => false };

function cua(tool: string, args: Record<string, unknown>, app?: AppIdentity | 'unresolved', platform: NodeJS.Platform = 'darwin'): PolicyCallInput {
    return {
        toolName: `mcp__cua-driver__${tool}`,
        args,
        platform,
        ...(app === undefined ? {} : { target: app === 'unresolved' ? { status: 'unresolved' as const } : { status: 'resolved' as const, app } }),
    };
}

function decide(input: PolicyCallInput, machine: MachinePolicy = ABSENT_MACHINE_POLICY, grants: PolicyGrantView = NO_GRANTS) {
    return evaluateToolCall(input, machine, grants);
}

const CHROME = { pid: 10, bundleId: 'com.google.Chrome', name: 'Google Chrome' };
const TERMINAL = { pid: 11, bundleId: 'com.apple.Terminal', name: 'Terminal' };
const FINDER = { pid: 12, bundleId: 'com.apple.finder', name: 'Finder' };
const NOTES = { pid: 13, bundleId: 'com.apple.Notes', name: 'Notes' };
const SAYCODE = { pid: 14, bundleId: 'com.saycode.desktop', name: 'Saycode' };
const SPOTIFY = { pid: 15, bundleId: 'com.spotify.client', name: 'Spotify' };
const KEYCHAIN = { pid: 16, bundleId: 'com.apple.keychainaccess', name: 'Keychain Access' };

describe('app grade table (policy-tables §1)', () => {
    it.each([
        ['browser read: screenshot allowed', 'get_window_state', { pid: 10 }, CHROME, 'allow', 'observe'],
        ['browser read: click blocked', 'click', { pid: 10, x: 1, y: 1 }, CHROME, 'blocked', 'grade_exceeded'],
        ['terminal click: left click asks first', 'click', { pid: 11, x: 1, y: 1 }, TERMINAL, 'ask', 'first_app_use'],
        ['terminal click: typing blocked', 'type_text', { pid: 11, text: 'rm -rf /' }, TERMINAL, 'blocked', 'grade_exceeded'],
        ['terminal click: right click blocked', 'click', { pid: 11, button: 'right' }, TERMINAL, 'blocked', 'grade_exceeded'],
        ['terminal click: modifier click blocked', 'click', { pid: 11, modifier: ['shift'] }, TERMINAL, 'blocked', 'grade_exceeded'],
        ['shell click: scroll asks first', 'scroll', { pid: 12, direction: 'down' }, FINDER, 'ask', 'first_app_use'],
        ['shell click: drag blocked', 'drag', { pid: 12 }, FINDER, 'blocked', 'grade_exceeded'],
        ['other full: typing asks first', 'type_text', { pid: 13, text: 'hi' }, NOTES, 'ask', 'first_app_use'],
        ['self: even observing blocked', 'get_window_state', { pid: 14 }, SAYCODE, 'blocked', 'self_target'],
        ['self: dev launcher prefix', 'click', { pid: 14 }, { ...SAYCODE, bundleId: 'com.saycode.desktop.dev.abcdef123456' }, 'blocked', 'self_target'],
        ['media: denied', 'click', { pid: 15 }, SPOTIFY, 'blocked', 'media_target'],
        ['keychain: shell raised to denied', 'click', { pid: 16 }, KEYCHAIN, 'blocked', 'denied_app'],
    ])('%s', (_label, tool, args, app, decision, reasonCode) => {
        const verdict = decide(cua(tool, args, app));
        expect(verdict).toMatchObject({ decision, reasonCode, serverKind: 'cua-driver' });
    });

    it('classifies Windows executables and name fallbacks', () => {
        expect(decide(cua('type_text', { pid: 1 }, { pid: 1, executable: 'C:\\Windows\\System32\\cmd.exe' }, 'win32')).reasonCode).toBe('grade_exceeded');
        expect(decide(cua('click', { pid: 1 }, { pid: 1, executable: 'C:\\Program Files\\Saycode\\Saycode.exe' }, 'win32')).reasonCode).toBe('self_target');
        expect(decide(cua('click', { pid: 1 }, { pid: 1, name: '영웅문4' })).target?.category).toBe('trading');
        expect(decide(cua('click', { pid: 1 }, { pid: 1, name: 'NAVER WORKS' })).target?.category).toBe('other');
        expect(decide(cua('click', { pid: 1 }, { pid: 1, bundleId: 'com.google.Chrome.app.abc' })).target?.category).toBe('browser');
    });

    it('treats pids Desktop recorded as its own as self', () => {
        const machine = parseMachinePolicy({ version: 1, selfIdentity: { pids: [4242] }, rules: [] });
        expect(decide(cua('click', { pid: 4242 }, { pid: 4242, bundleId: 'com.github.Electron', name: 'Electron' }), machine).reasonCode).toBe('self_target');
    });

    it('carries R12 three-part text with the alternative path', () => {
        const message = decide(cua('type_text', { pid: 11 }, TERMINAL)).message ?? '';
        expect(message).toContain('Terminal');
        expect(message).toContain('Bash');
        expect(message).toContain('우회하지 마라');
    });
});

describe('cua-driver action table (policy-tables §2)', () => {
    it.each([
        ['list_apps', {}, 'allow', 'observe'],
        ['start_session', {}, 'allow', 'session_meta'],
        ['replay_trajectory', {}, 'ask', 'ask_always_tool'],
        ['set_config', {}, 'blocked', 'admin_tool'],
        ['install_extension', {}, 'blocked', 'admin_tool'],
        ['brand_new_tool', {}, 'ask', 'unlisted_cua_tool'],
        ['clipboard_read', {}, 'ask', 'clipboard_first_use'],
    ])('%s', (tool, args, decision, reasonCode) => {
        expect(decide(cua(tool, args))).toMatchObject({ decision, reasonCode });
    });

    it('judges browser tab tools against the browser, never the frontmost app', () => {
        expect(requiredCuaTarget('mcp__cua-driver__browser_type', { tab_id: 't', text: 'x' })).toEqual({ kind: 'none' });
        expect(decide(cua('browser_type', { tab_id: 't', text: 'x' }))).toMatchObject({ decision: 'blocked', reasonCode: 'grade_exceeded', target: { category: 'browser' } });
        expect(decide(cua('page', { tab_id: 't' })).message).toContain('브라우저 도구');
        expect(decide(cua('get_browser_state', {}))).toMatchObject({ decision: 'allow', reasonCode: 'observe' });
        const rules = parseMachinePolicy({ version: 1, rules: [{ id: 'b', tool: 'mcp__cua-driver__*', target: 'browser', decision: 'allow' }] });
        expect(decide(cua('browser_click', { tab_id: 't' }), rules)).toMatchObject({ decision: 'allow', ruleId: 'machine:b' });
    });

    it('launch_app with urls asks a person once, whatever the app grade', () => {
        const verdict = decide(cua('launch_app', { bundle_id: 'com.apple.Notes', urls: ['/tmp/x.command'] }, { bundleId: 'com.apple.Notes' }));
        expect(verdict).toMatchObject({ decision: 'ask', reasonCode: 'launch_with_arguments', humanOnly: true, grantOffer: 'once' });
    });

    it('an unresolved target asks once', () => {
        expect(decide(cua('click', { scope: 'desktop', x: 1, y: 1 }, 'unresolved'))).toMatchObject({ decision: 'ask', reasonCode: 'target_unresolved', grantOffer: 'once' });
    });

    it('terminal and shell first grants are human-only (R11.1)', () => {
        expect(decide(cua('click', { pid: 11 }, TERMINAL)).humanOnly).toBe(true);
        expect(decide(cua('click', { pid: 13 }, NOTES)).humanOnly).toBe(false);
    });

    it('reads the target the call acts on (R5.1)', () => {
        expect(requiredCuaTarget('mcp__cua-driver__click', { pid: 5 })).toEqual({ kind: 'pid', pid: 5 });
        expect(requiredCuaTarget('mcp__cua-driver__hotkey', { keys: ['cmd', 'c'], target: { kind: 'window', pid: 6, window_id: 1 } })).toEqual({ kind: 'pid', pid: 6 });
        expect(requiredCuaTarget('mcp__cua-driver__type_text', { text: 'x', scope: 'desktop' })).toEqual({ kind: 'frontmost' });
        expect(requiredCuaTarget('mcp__cua-driver__type_text', { text: 'x' })).toEqual({ kind: 'frontmost' });
        expect(requiredCuaTarget('mcp__cua-driver__click', { element_token: 't' })).toEqual({ kind: 'unknown' });
        expect(requiredCuaTarget('mcp__cua-driver__list_windows', {})).toEqual({ kind: 'none' });
        expect(requiredCuaTarget('mcp__cua-driver__launch_app', { name: 'Notes' })).toEqual({ kind: 'launch', app: { name: 'Notes' } });
        expect(requiredCuaTarget('mcp__notion__notion-search', { pid: 1 })).toEqual({ kind: 'none' });
    });
});

describe('system key combos (policy-tables §3, R7)', () => {
    it.each([
        ['darwin', ['cmd', 'q']],
        ['darwin', ['command', 'shift', 'q']],
        ['darwin', ['cmd', 'tab']],
        ['darwin', ['cmd', 'shift', '4']],
        ['win32', ['alt', 'f4']],
        ['win32', ['win', 'r']],
        ['linux', ['ctrl', 'alt', 'f3']],
    ] as const)('%s %j is blocked even on a full app', (platform, keys) => {
        const verdict = decide(cua('hotkey', { pid: 13, keys: [...keys] }, NOTES, platform));
        expect(verdict).toMatchObject({ decision: 'blocked', reasonCode: 'system_key_combo' });
    });

    it('press_key modifiers and click modifiers are checked the same way', () => {
        expect(decide(cua('press_key', { pid: 13, key: 'q', modifiers: ['cmd'] }, NOTES)).reasonCode).toBe('system_key_combo');
        expect(decide(cua('press_key', { pid: 13, key: 'esc', modifiers: ['cmd', 'option'] }, NOTES)).reasonCode).toBe('system_key_combo');
    });

    it('several non-modifier keys or more than eight keys are blocked', () => {
        expect(decide(cua('hotkey', { pid: 13, keys: ['cmd', 'a', 'b'] }, NOTES)).reasonCode).toBe('too_many_keys');
        expect(decide(cua('hotkey', { pid: 13, keys: ['ctrl', 'alt', 'shift', 'meta', 'cmd', 'command', 'super', 'win', 'x'] }, NOTES)).reasonCode).toBe('too_many_keys');
    });

    it('clipboard combos need a clipboard grant as well as the app grant', () => {
        const paste = decide(cua('hotkey', { pid: 13, keys: ['cmd', 'v'] }, NOTES));
        expect(paste).toMatchObject({ decision: 'ask', action: 'clipboard_read', grantKeys: ['app:com.apple.Notes', 'clipboard:clipboard_read'] });
        const appOnly: PolicyGrantView = { hasGrant: (key) => key === 'app:com.apple.Notes', recentlyDenied: () => false };
        expect(decide(cua('hotkey', { pid: 13, keys: ['cmd', 'v'] }, NOTES), ABSENT_MACHINE_POLICY, appOnly).decision).toBe('ask');
        expect(decide(cua('hotkey', { pid: 13, keys: ['cmd', 'b'] }, NOTES), ABSENT_MACHINE_POLICY, appOnly).decision).toBe('allow');
    });
});

describe('MCP tool defaults (policy-tables §4, R8)', () => {
    const mcp = (toolName: string, annotations?: PolicyCallInput['annotations']): PolicyCallInput => ({ toolName, args: {}, platform: 'darwin', annotations });

    it.each([
        ['mcp__notion__notion-delete-page', 'ask', 'high_risk_write'],
        ['mcp__gmail__gmail_send', 'ask', 'high_risk_write'],
        ['mcp__slack__slack_post_message', 'ask', 'high_risk_write'],
        ['mcp__github__github_merge_pull_request', 'ask', 'high_risk_write'],
        ['mcp__notion__notion-update-page', 'allow', 'write_tool'],
        ['mcp__linear__createIssue', 'allow', 'write_tool'],
        ['mcp__x__get_deleted_items', 'allow', 'default_allow'],
        ['mcp__notion__notion-search', 'allow', 'default_allow'],
    ])('%s → %s (%s)', (toolName, decision, reasonCode) => {
        expect(decide(mcp(toolName))).toMatchObject({ decision, reasonCode, serverKind: 'user' });
    });

    it('high-risk writes are human-only and grantable for the conversation', () => {
        expect(decide(mcp('mcp__gmail__send_email'))).toMatchObject({ humanOnly: true, grantOffer: 'session', grantKeys: ['tool:mcp__gmail__send_email'] });
    });

    it('annotations only tighten (R8.3)', () => {
        expect(decide(mcp('mcp__gmail__send_email', { readOnlyHint: true })).reasonCode).toBe('high_risk_write');
        expect(decide(mcp('mcp__x__frobnicate', { destructiveHint: true })).reasonCode).toBe('write_tool');
        expect(decide(mcp('mcp__x__update_doc', { readOnlyHint: true })).reasonCode).toBe('default_allow');
    });

    it('"ask for write tools" turns plain writes into ask', () => {
        const machine = parseMachinePolicy({ version: 1, rules: [], settings: { askWriteTools: true } });
        expect(decide(mcp('mcp__notion__notion-update-page'), machine).decision).toBe('ask');
    });

    it('verb dictionary reads the first two words only', () => {
        expect(verbOf('notion-delete-page')).toBe('high');
        expect(verbOf('list_items_delete')).toBeNull();
        expect(verbOf('sendMessage')).toBe('high');
    });
});

describe('combination order (R2, R3, R13)', () => {
    const machine = (rules: unknown[]) => parseMachinePolicy({ version: 1, rules });

    it('the most restrictive machine rule wins over a narrower allow', () => {
        const rules = machine([
            { id: 'all', tool: 'mcp__notion__*', decision: 'blocked' },
            { id: 'one', tool: 'mcp__notion__notion-search', decision: 'allow' },
        ]);
        expect(decide({ toolName: 'mcp__notion__notion-search', args: {}, platform: 'darwin' }, rules)).toMatchObject({ decision: 'blocked', ruleId: 'machine:all' });
    });

    it('a machine allow cannot lift a builtin floor or fixed block', () => {
        const rules = machine([{ id: 'open', tool: 'mcp__*', decision: 'allow' }]);
        expect(decide({ toolName: 'mcp__gmail__send_email', args: {}, platform: 'darwin' }, rules)).toMatchObject({ decision: 'ask', reasonCode: 'floor' });
        expect(decide(cua('click', { pid: 14 }, SAYCODE), rules).decision).toBe('blocked');
        expect(decide(cua('hotkey', { pid: 13, keys: ['cmd', 'q'] }, NOTES), rules).decision).toBe('blocked');
    });

    it('a blanket machine allow does not cover a target that could not be resolved', () => {
        const rules = machine([{ id: 'all-cua', tool: 'mcp__cua-driver__*', decision: 'allow' }]);
        expect(decide(cua('click', { scope: 'desktop', x: 1, y: 1 }, 'unresolved'), rules)).toMatchObject({ decision: 'ask', reasonCode: 'floor' });
    });

    it('a machine rule can allow a browser by app and target', () => {
        const rules = machine([{ id: 'chrome', tool: 'mcp__cua-driver__*', target: 'com.google.Chrome', decision: 'allow' }]);
        expect(decide(cua('click', { pid: 10 }, CHROME), rules)).toMatchObject({ decision: 'allow', ruleId: 'machine:chrome' });
        expect(decide(cua('click', { pid: 11 }, TERMINAL), rules).reasonCode).toBe('first_app_use');
    });

    it('a malformed rule degrades to ask, never blocked (R3)', () => {
        const rules = machine([{ id: 'typo', tool: 'mcp__notion__*', decision: 'deny' }]);
        expect(decide({ toolName: 'mcp__notion__notion-search', args: {}, platform: 'darwin' }, rules)).toMatchObject({ decision: 'ask', reasonCode: 'machine_rule_invalid' });
        expect(parseMachinePolicy('garbage').rules).toEqual([{ id: 'file-unreadable', tool: 'mcp__*', decision: 'ask' }]);
        expect(parseMachinePolicy({ version: 2, rules: [{ tool: 'mcp__*', decision: 'blocked' }] })).toMatchObject({ status: 'unsupported', rules: [] });
    });

    it('an unreadable file or malformed rule never loosens a builtin block (R3)', () => {
        const unreadable = parseMachinePolicy('half-written');
        expect(decide(cua('type_text', { pid: 10 }, CHROME), unreadable)).toMatchObject({ decision: 'blocked', reasonCode: 'grade_exceeded' });
        expect(decide({ toolName: 'mcp__notion__notion-search', args: {}, platform: 'darwin' }, unreadable)).toMatchObject({ decision: 'ask', reasonCode: 'machine_rule_invalid' });
        const mixed = machine([{ id: 'open', tool: 'mcp__cua-driver__*', target: 'browser', decision: 'allow' }, { id: 'typo', tool: 'mcp__cua-driver__*', decision: 'nope' }]);
        expect(decide(cua('click', { pid: 10 }, CHROME), mixed)).toMatchObject({ decision: 'ask', reasonCode: 'machine_rule_invalid' });
    });

    it('expired machine rules are ignored', () => {
        const rules = parseMachinePolicy({ version: 1, rules: [{ id: 'old', tool: 'mcp__*', decision: 'blocked', expiresAt: 1000 }] });
        expect(evaluateToolCall({ toolName: 'mcp__x__read', args: {}, platform: 'darwin' }, rules, NO_GRANTS, undefined, 2000).decision).toBe('allow');
    });

    it('a session grant turns ask into allow but never blocked', () => {
        const all: PolicyGrantView = { hasGrant: () => true, recentlyDenied: () => false };
        expect(decide(cua('click', { pid: 13 }, NOTES), ABSENT_MACHINE_POLICY, all)).toMatchObject({ decision: 'allow', reasonCode: 'session_grant' });
        expect(decide(cua('type_text', { pid: 11 }, TERMINAL), ABSENT_MACHINE_POLICY, all).decision).toBe('blocked');
        expect(decide(cua('launch_app', { name: 'Notes', urls: ['x'] }, { name: 'Notes' }), ABSENT_MACHINE_POLICY, all).decision).toBe('ask');
    });

    it('a call a person just declined is blocked without asking again (R13)', () => {
        const declined: PolicyGrantView = { hasGrant: () => false, recentlyDenied: (key) => key === 'click|com.apple.Notes' };
        const verdict = decide(cua('click', { pid: 13 }, NOTES), ABSENT_MACHINE_POLICY, declined);
        expect(verdict).toMatchObject({ decision: 'blocked', reasonCode: 'recently_denied' });
        expect(verdict.message).toContain('반복하지 마라');
    });

    it('is a pure function of its inputs (R1)', () => {
        const input = cua('click', { pid: 13 }, NOTES);
        expect(decide(input)).toEqual(decide(input));
        expect(decide(input).policyVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    });
});
