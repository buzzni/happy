import { describe, expect, it } from 'vitest';
import { buildConnectorToolGuidance } from './connectorToolGuidance';

describe('buildConnectorToolGuidance', () => {
    it('requires connector discovery before unsupported or browser fallback claims', () => {
        const guidance = buildConnectorToolGuidance(['gmail', 'knoi']);

        expect(guidance).toContain('gmail, knoi');
        expect(guidance).toContain('deferred MCP tool discovery');
        expect(guidance).toContain('Do not claim that the integration is unsupported');
        expect(guidance).toContain('browser fallback');
        expect(guidance).not.toContain('account');
    });

    it('omits guidance when no personal connector is expected', () => {
        expect(buildConnectorToolGuidance([])).toBe('');
    });
});
