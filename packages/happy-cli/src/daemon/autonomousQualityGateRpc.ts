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
): AutonomousQualityGateRpcHandlers {
    return {
        start: async params => registry.start(AutonomousQualityGateStartRequestV1Schema.parse(params)),
        status: async (params) => {
            const request = AutonomousQualityGateStatusRequestV1Schema.parse(params);
            return registry.status(request.sessionId);
        },
        control: async params => registry.control(AutonomousQualityGateControlRequestV1Schema.parse(params)),
    };
}
