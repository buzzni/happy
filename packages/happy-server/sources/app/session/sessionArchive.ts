import { Context } from "@/context";
import { inTx, afterTx } from "@/storage/inTx";
import { buildSessionActivityEphemeral, eventRouter } from "@/app/events/eventRouter";
import { persistSessionEvent } from "@/app/events/persistSessionEvent";
import { SESSION_EVENT_TYPES } from "@/app/events/sessionEventTypes";
import { log } from "@/utils/log";

/**
 * Archive a session by marking it as inactive (active=false).
 *
 * - If the session does not exist or is not owned by the requesting user, returns false.
 * - If the session is already inactive, returns true without re-emitting events (idempotent).
 * - If the session is active, updates active=false and lastActiveAt=now, then:
 *   - emits a session-activity(active=false) ephemeral to user-scoped connections
 *   - persists a SESSION_END event to the durable log
 *
 * @param ctx - Context with user information
 * @param sessionId - ID of the session to archive
 * @returns true if the session is now inactive, false if not found or not owned by user
 */
export async function sessionArchive(ctx: Context, sessionId: string): Promise<boolean> {
    return await inTx(async (tx) => {
        // Verify session exists and belongs to the user
        const session = await tx.session.findFirst({
            where: {
                id: sessionId,
                accountId: ctx.uid
            }
        });

        if (!session) {
            return false;
        }

        // Idempotent: already inactive, no need to re-emit events
        if (!session.active) {
            return true;
        }

        const now = new Date();

        // Mark session as inactive
        await tx.session.update({
            where: { id: sessionId },
            data: { active: false, lastActiveAt: now }
        });

        // After transaction commits, emit ephemeral update and persist session-end event
        afterTx(tx, () => {
            // reason: 'archived' + session-scoped delivery so a still-running CLI on
            // this session learns it was archived and shuts down gracefully, instead
            // of hammering the (now 404) message endpoint forever. 'all-interested-in-session'
            // unions the session room with user-scoped, so the app is still notified too.
            const sessionActivity = buildSessionActivityEphemeral(sessionId, false, now.getTime(), false, 'archived');
            eventRouter.emitEphemeral({
                userId: ctx.uid,
                payload: sessionActivity,
                recipientFilter: { type: 'all-interested-in-session', sessionId }
            });

            persistSessionEvent({
                sessionId,
                eventType: SESSION_EVENT_TYPES.SESSION_END,
                content: '',
            }).catch((err) => {
                log({ module: 'session-archive', userId: ctx.uid, sessionId, level: 'error' },
                    `Failed to persist session-end event: ${err}`);
            });
        });

        return true;
    });
}
