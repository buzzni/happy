import { logger } from '@/ui/logger';
import type { TrackedSession } from './types';

export type DaemonSessionStateResponse = {
    version: 1;
    state: 'present' | 'missing' | 'unknown';
};

/** The same current child snapshot as /list; persisted resume history is not liveness. */
export function createDaemonSessionStateHandler(getChildren: () => readonly TrackedSession[]) {
    return async (request: unknown): Promise<DaemonSessionStateResponse> => {
        if (!request || typeof request !== 'object'
            || !('sessionId' in request) || typeof request.sessionId !== 'string'
            || request.sessionId.trim().length === 0) {
            return { version: 1, state: 'unknown' };
        }
        try {
            const present = getChildren().some(child => child.happySessionId === request.sessionId);
            return { version: 1, state: present ? 'present' : 'missing' };
        } catch {
            logger.debug('[DAEMON SESSION STATE] Could not read tracked children');
            return { version: 1, state: 'unknown' };
        }
    };
}
