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
    return [
        expectedServices.length > 0
            ? `Saycode expects these connected MCP services in this session: ${expectedServices.join(', ')}.`
            : 'No expected Saycode MCP services are listed here; this does not establish that no services are connected.',
        'Before saying a service is unavailable or choosing a browser fallback, perform deferred MCP tool discovery for that service.',
        'If an expected service is absent or unusable, report an MCP configuration, authentication, or runtime problem.',
        'Use only Saycode connector gateway state for that diagnosis; a same-named claude.ai connector is a different integration and is not evidence about Saycode authentication.',
        'A separate OpenAI or ChatGPT plugin catalog reporting installed: false is not evidence that a Saycode connector is disconnected; do not recommend plugin installation to repair Saycode caller authentication.',
        'Do not recommend claude.ai connector reauthorization as a fix unless the user explicitly asked about that separate integration.',
        'Do not claim that the integration is unsupported solely because its tools are not currently visible.',
    ].join(' ');
}
