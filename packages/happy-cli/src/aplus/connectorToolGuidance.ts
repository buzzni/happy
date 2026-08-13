const INTERNAL_MCP_SERVERS = new Set(['happy', 'aplus-common', 'aplus-company']);

export function listExpectedMcpServices(input: {
    expectedConnectors: string[];
    expectedMcpServices: string[];
    configuredServerNames: string[];
}): string[] {
    return [...new Set([
        ...input.expectedConnectors,
        ...input.expectedMcpServices,
        ...input.configuredServerNames,
    ].filter((name) => (
        /^[a-z0-9-]{1,64}$/.test(name) && !INTERNAL_MCP_SERVERS.has(name)
    )))].sort();
}

export function buildConnectorToolGuidance(expectedServices: string[]): string {
    if (expectedServices.length === 0) return '';
    return [
        `Saycode expects these connected MCP services in this session: ${expectedServices.join(', ')}.`,
        'Before saying a service is unavailable or choosing a browser fallback, perform deferred MCP tool discovery for that service.',
        'If an expected service is absent or unusable, report an MCP configuration, authentication, or runtime problem.',
        'Do not claim that the integration is unsupported solely because its tools are not currently visible.',
    ].join(' ');
}
