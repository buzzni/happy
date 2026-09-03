import axios from 'axios';
import { z } from 'zod';
import { encodeBase64, encrypt } from '@/api/encryption';
import { configuration } from '@/configuration';
import {
    checkpointEventDetailSchema,
    type CheckpointEventDetail,
} from './checkpointContract';

type CheckpointFileSummary = CheckpointEventDetail['summary']['files'][number];
type CheckpointExcludedSummary = CheckpointEventDetail['summary']['excluded'][number];

export type CheckpointEventAck = {
    id: string;
    seq: number;
    createdAt: number;
    idempotent: boolean;
};

export interface CheckpointEventPublisher {
    snapshot(input: {
        operationId: string;
        checkpointId: string;
        excluded: CheckpointExcludedSummary[];
    }): Promise<CheckpointEventAck>;
    rewind(input: {
        operationId: string;
        checkpointId: string;
        state: 'completed' | 'partial' | 'failed';
        files: CheckpointFileSummary[];
    }): Promise<CheckpointEventAck>;
}

export type CheckpointEventRequest = {
    url: string;
    token: string;
    body: {
        eventType: 'checkpoint-snapshot' | 'checkpoint-rewind';
        content: string;
        checkpoint: {
            schemaVersion: 1;
            operationId: string;
            checkpointId: string;
            state: CheckpointEventDetail['state'];
            actor: CheckpointEventDetail['actor'];
            timestamp: number;
        };
    };
};

type CheckpointEventPost = (request: CheckpointEventRequest) => Promise<unknown>;
const operationIdSchema = z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);

const acknowledgementSchema = z.object({
    event: z.object({
        id: z.string().min(1).max(128),
        seq: z.number().int().nonnegative(),
        createdAt: z.number().int().nonnegative(),
        idempotent: z.boolean(),
    }).strict(),
}).strict();

export function createCheckpointEventPublisher(
    input: {
        token: string;
        sessionId: string;
        serverUrl?: string;
        encryption: {
            encryptionKey: Uint8Array;
            encryptionVariant: 'legacy' | 'dataKey';
        };
    },
    dependencies: {
        post?: CheckpointEventPost;
        now?: () => number;
    } = {},
): CheckpointEventPublisher {
    const post = dependencies.post ?? postCheckpointEvent;
    const now = dependencies.now ?? Date.now;
    const serverUrl = input.serverUrl ?? configuration.serverUrl;

    const publish = async (
        eventType: CheckpointEventRequest['body']['eventType'],
        operationId: string,
        detailInput: unknown,
    ): Promise<CheckpointEventAck> => {
        const parsedOperationId = operationIdSchema.parse(operationId);
        const detail = checkpointEventDetailSchema.parse(detailInput);
        const response = await post({
            url: `${serverUrl}/v3/sessions/${encodeURIComponent(input.sessionId)}/events`,
            token: input.token,
            body: {
                eventType,
                content: encodeBase64(encrypt(
                    input.encryption.encryptionKey,
                    input.encryption.encryptionVariant,
                    detail,
                )),
                checkpoint: {
                    schemaVersion: 1,
                    operationId: parsedOperationId,
                    checkpointId: detail.checkpointId,
                    state: detail.state,
                    actor: detail.actor,
                    timestamp: detail.timestamp,
                },
            },
        });
        const parsed = acknowledgementSchema.safeParse(response);
        if (!parsed.success) {
            throw new Error('checkpoint event server returned an invalid acknowledgement');
        }
        return parsed.data.event;
    };

    return {
        snapshot: ({ operationId, checkpointId, excluded }) => {
            const timestamp = now();
            return publish('checkpoint-snapshot', operationId, {
                schemaVersion: 1,
                checkpointId,
                state: 'created',
                actor: 'agent',
                timestamp,
                summary: { files: [], excluded },
            });
        },
        rewind: ({ operationId, checkpointId, state, files }) => {
            const timestamp = now();
            return publish('checkpoint-rewind', operationId, {
                schemaVersion: 1,
                checkpointId,
                state,
                actor: 'user',
                timestamp,
                summary: { files, excluded: [] },
            });
        },
    };
}

async function postCheckpointEvent(request: CheckpointEventRequest): Promise<unknown> {
    const response = await axios.post(request.url, request.body, {
        headers: {
            Authorization: `Bearer ${request.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
        },
        timeout: 10_000,
    });
    return response.data;
}
