/** Only the human response may choose a lease or remember consent; never merge tool input. */
export function parseBrowserClientConsent(raw: unknown): { leaseMinutes: 15 | 60 | 1440; rememberSameScope: boolean } | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const value = raw as Record<string, unknown>
    if (Object.keys(value).some(k => !['leaseMinutes', 'rememberSameScope'].includes(k))) return undefined
    if (![15, 60, 1440].includes(value.leaseMinutes as number) || typeof value.rememberSameScope !== 'boolean') return undefined
    return { leaseMinutes: value.leaseMinutes as 15 | 60 | 1440, rememberSameScope: value.rememberSameScope }
}
