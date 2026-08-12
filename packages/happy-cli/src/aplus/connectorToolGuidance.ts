export function buildConnectorToolGuidance(expectedConnectors: string[]): string {
    if (expectedConnectors.length === 0) return '';
    return [
        `Saycode expects these connected connectors in this session: ${expectedConnectors.join(', ')}.`,
        'Before saying a service connector is unavailable or choosing a browser fallback, perform deferred MCP tool discovery for that provider.',
        'If an expected provider is absent or unusable, report a connector configuration, authentication, or runtime problem.',
        'Do not claim that the integration is unsupported solely because its tools are not currently visible.',
    ].join(' ');
}
