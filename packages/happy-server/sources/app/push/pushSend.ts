/**
 * Sends push notifications via Expo's HTTP Push API.
 * Direct HTTP POST — no expo-server-sdk dependency needed.
 * Batches up to 100 tokens per request (Expo's documented limit).
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100;

/**
 * One deadline for the whole send. `/v1/sessions/:id/push-event` awaits the
 * result, so it must finish well inside the CLI's 15s request timeout instead
 * of holding the request open on a hanging Expo call.
 */
const SEND_TIMEOUT_MS = 8_000;

export interface PushMessage {
    to: string;
    title?: string;
    body?: string;
    data?: Record<string, unknown>;
    sound?: 'default' | null;
    badge?: number;
    channelId?: string;
}

export interface PushTicket {
    status: 'ok' | 'error';
    id?: string;
    message?: string;
    details?: { error?: string };
}

export async function sendPushNotifications(
    messages: PushMessage[],
    options: { timeoutMs?: number } = {}
): Promise<PushTicket[]> {
    if (messages.length === 0) {
        return [];
    }

    const tickets: PushTicket[] = [];
    // Shared across batches so a large fan-out cannot extend the total wait.
    const signal = AbortSignal.timeout(options.timeoutMs ?? SEND_TIMEOUT_MS);

    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const batch = messages.slice(i, i + BATCH_SIZE);
        try {
            const response = await fetch(EXPO_PUSH_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(batch),
                signal
            });

            if (!response.ok) {
                tickets.push(...batch.map(() => ({
                    status: 'error' as const,
                    message: `HTTP ${response.status}`
                })));
                continue;
            }

            const result = await response.json() as { data: PushTicket[] };
            tickets.push(...result.data);
        } catch {
            tickets.push(...batch.map(() => ({
                status: 'error' as const,
                message: signal.aborted ? 'Timeout' : 'Network error'
            })));
        }
    }

    return tickets;
}
