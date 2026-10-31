import {
    AutonomousQualityGateControlRequestV1Schema,
    AutonomousQualityGateStartRequestV1Schema,
    AutonomousQualityGateStatusRequestV1Schema,
    type AutonomousQualityGateControlRequestV1,
    type AutonomousQualityGateStartRequestV1,
    type AutonomousQualityGateStatusV1,
} from '../api/autonomousQualityGateProtocol';

export interface AutonomousQualityGateRegistry {
    start(request: AutonomousQualityGateStartRequestV1): Promise<AutonomousQualityGateStatusV1 | unknown>;
    status(sessionId: string): Promise<AutonomousQualityGateStatusV1 | null | unknown>;
    control(request: AutonomousQualityGateControlRequestV1): Promise<unknown>;
}

export interface AutonomousQualityGateRpcHandlers {
    start(params: unknown): Promise<unknown>;
    status(params: unknown): Promise<unknown>;
    control(params: unknown): Promise<unknown>;
}

export function createAutonomousQualityGateRpcHandlers(
    registry: AutonomousQualityGateRegistry,
    options: {
        /**
         * A reason to refuse this start, or null (aplus-dev-studio-desktop specs/codexcli-org-requirements
         * R10.5: the session's organization switched autopilot off). Refused before the registry sees it.
         */
        refuseStart?: (request: AutonomousQualityGateStartRequestV1) => string | null;
    } = {},
): AutonomousQualityGateRpcHandlers {
    return {
        start: async params => {
            const request = AutonomousQualityGateStartRequestV1Schema.parse(params);
            const refusal = options.refuseStart?.(request);
            if (refusal) throw new Error(`autonomous quality gate refused: ${refusal}`);
            return registry.start(request);
        },
        status: async (params) => {
            const request = AutonomousQualityGateStatusRequestV1Schema.parse(params);
            return registry.status(request.sessionId);
        },
        control: async params => registry.control(AutonomousQualityGateControlRequestV1Schema.parse(params)),
    };
}
