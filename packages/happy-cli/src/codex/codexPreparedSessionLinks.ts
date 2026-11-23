function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

function emptyTable(value: unknown): boolean {
    return value == null || (isRecord(value) && Object.keys(value).length === 0);
}

function emptyList(value: unknown): boolean {
    return value == null || (Array.isArray(value) && value.length === 0);
}

/** Link values can use `set` only if it preserves the normal shell inheritance and native tool environment. */
export function permitsPreparedSessionLinks(configResult: unknown, requirementsResult: unknown): boolean {
    if (!isRecord(configResult) || !isRecord(configResult.config)
        || !isRecord(requirementsResult) || requirementsResult.requirements !== null) return false;
    const config = configResult.config;
    if (!emptyTable(config.plugins) || !emptyTable(config.mcp_servers) || !emptyList(config.notify)) return false;
    const policy = config.shell_environment_policy;
    if (policy == null) return true;
    if (!isRecord(policy)) return false;
    return Object.entries(policy).every(([key, value]) => {
        switch (key) {
            case 'inherit': return value == null || value === 'all';
            case 'exclude':
            case 'include_only': return emptyList(value);
            case 'set':
            case 'filters': return emptyTable(value);
            case 'ignore_default_excludes': return value == null || typeof value === 'boolean';
            case 'experimental_use_profile': return value == null || value === false;
            default: return false;
        }
    });
}

export function hasNoNativeHooks(result: unknown, cwd: string): boolean {
    if (!isRecord(result) || !Array.isArray(result.data) || result.data.length !== 1) return false;
    const [entry] = result.data;
    return isRecord(entry) && entry.cwd === cwd
        && ['hooks', 'warnings', 'errors'].every(key => Array.isArray(entry[key]) && entry[key].length === 0);
}
