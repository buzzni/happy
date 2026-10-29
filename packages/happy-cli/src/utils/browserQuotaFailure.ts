/** Only a top-level runtime error envelope is metadata; page content and prose are never inspected. */
export function browserQuotaFailure(value: unknown): 'spaces' | 'tabs' | 'windows' | 'time' | 'journal' | undefined {
    if (typeof value === 'string') {
        if (value.length > 65536) return;
        try { return browserQuotaFailure(JSON.parse(value)); } catch { return; }
    }
    if (Array.isArray(value)) {
        for (const block of value) if (block?.type === 'text') {
            const kind = browserQuotaFailure(block.text); if (kind) return kind;
        }
        return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, any>;
    if ('result' in record) return;
    if (record.error?.code === 'QUOTA_EXCEEDED' && ['spaces','tabs','windows','time','journal'].includes(record.error.quotaKind)) return record.error.quotaKind;
    if (record.isError === true && Array.isArray(record.content)) return browserQuotaFailure(record.content);
    return undefined;
}
