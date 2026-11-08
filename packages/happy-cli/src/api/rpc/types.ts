import type { RpcLatencySnapshot } from '@slopus/happy-wire';

/**
 * Common RPC types and interfaces for both session and machine clients
 */

/**
 * Generic RPC handler function type
 * @template TRequest - The request data type
 * @template TResponse - The response data type
 */
export type RpcHandler<TRequest = any, TResponse = any> = (
    data: TRequest,
    /** Passed only on the delegation lane; customer and server lane calls keep their one argument. */
    context?: RpcCallContext,
) => TResponse | Promise<TResponse>;

export interface RpcCallContext {
    lane: 'delegation';
    /** The machine whose link key opened the request. */
    peer: string;
}

/**
 * Map of method names to their handlers
 */
export type RpcHandlerMap = Map<string, RpcHandler>;

/**
 * RPC request data from server
 */
export interface RpcRequest {
    method: string;
    params: string; // Base64 encoded encrypted params
    rpcLatency?: unknown; // Optional versioned diagnostics, never authority.
}

/**
 * RPC response callback
 */
export type RpcResponseCallback = (response: string | { result: string; rpcLatency: RpcLatencySnapshot }) => void;

/**
 * Configuration for RPC handler manager
 */
export interface RpcHandlerConfig {
    scopePrefix: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    logger?: (message: string, data?: any) => void;
    /**
     * aplus-dev-studio specs/e2ee-machine-control-boundary R2/R3 — a second
     * key (AES-256-GCM) the server holds instead of the machine key. Requests
     * it opens run only methods `allows` accepts, and are answered with it.
     */
    serverLane?: ServerLaneConfig;
    /**
     * aplus-dev-studio specs/cross-machine-agent-delegation — keys (AES-256-GCM) another machine
     * holds because a person linked it to this one. Tried after the scope and server keys; requests
     * they open must be bound, run only methods `allows` accepts, and are answered with that key.
     */
    delegationLane?: DelegationLaneConfig;
    /**
     * aplus-dev-studio specs/e2ee-machine-control-boundary R19 — strict machine
     * control: a customer-lane request must be bound (R18). An unbound one is
     * refused before any handler runs.
     */
    requireBoundRequests?: boolean;
    /**
     * How many bound requests one scope remembers within the time window (default 10,000).
     * When full, strict refuses new ones and compat forgets its oldest.
     */
    maxBoundRequestsInWindow?: number;
}

export interface ServerLaneConfig {
    encryptionKey: Uint8Array;
    /** Receives the method name without the scope prefix. */
    allows: (method: string) => boolean;
}

export interface DelegationLink {
    /** The machine allowed to send through this key. */
    peer: string;
    key: Uint8Array;
}

export interface DelegationLaneConfig {
    links: () => readonly DelegationLink[];
    /** Receives the method name without the scope prefix. */
    allows: (method: string) => boolean;
    /** A refusal for one call by its params, decided before the handler runs; null admits it. */
    admit?: (method: string, params: unknown, peer: string) => { error: string; code: string } | null;
}

/**
 * Result of RPC handler execution
 */
export type RpcHandlerResult<T = any> =
    | { success: true; data: T }
    | { success: false; error: string };