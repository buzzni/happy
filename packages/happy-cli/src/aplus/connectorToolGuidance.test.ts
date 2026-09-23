import { describe, expect, it } from 'vitest';
import { buildConnectorToolGuidance, listExpectedMcpServices } from './connectorToolGuidance';

describe('buildConnectorToolGuidance', () => {
    it('requires connector discovery before unsupported or browser fallback claims', () => {
        const guidance = buildConnectorToolGuidance(['gmail', 'knoi']);

        expect(guidance).toContain('gmail, knoi');
        expect(guidance).toContain('deferred MCP tool discovery');
        expect(guidance).toContain('same-named claude.ai connector is a different integration');
        expect(guidance).toContain('Do not recommend claude.ai connector reauthorization');
        expect(guidance).toContain('Do not claim that the integration is unsupported');
        expect(guidance).toContain('browser fallback');
        expect(guidance).not.toContain('account');
    });

    it('keeps platform diagnosis guidance when the expected inventory is unknown', () => {
        const guidance = buildConnectorToolGuidance([], { connectorPlatformConfigured: true });
        expect(guidance).toContain('deferred MCP tool discovery');
        expect(guidance).toContain('installed: false');
        expect(guidance).not.toContain('expects these connected');
        expect(guidance).toContain('does not establish that no services are connected');
    });

    // A session with no connector platform behind it is not a session whose
    // inventory is unknown: there is nothing to diagnose, so the connector
    // repair policy must stay out of its prompt.
    it('omits guidance when no connector platform is configured', () => {
        expect(buildConnectorToolGuidance([])).toBe('');
        expect(buildConnectorToolGuidance([], { connectorPlatformConfigured: false })).toBe('');
    });

    it('combines personal connectors and runtime MCP services while excluding internal servers', () => {
        expect(listExpectedMcpServices({
            expectedConnectors: ['gmail'],
            expectedMcpServices: ['argos'],
            configuredServerNames: ['happy', 'aplus-common', 'aplus-company', 'gmail', 'argos'],
        })).toEqual(['argos', 'gmail']);
    });
});
