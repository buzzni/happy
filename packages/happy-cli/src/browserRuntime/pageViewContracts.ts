/** Human-only page viewer wire contract. No CDP identifiers or arbitrary commands cross it. */
import { z } from 'zod'
import type { AuthContext, ProfileId, TabId, TaskId } from './contracts'

export type PageInput =
    | { kind: 'pointer'; type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'; x: number; y: number; button: 'none' | 'left' | 'middle' | 'right'; buttons: number; clickCount: number; modifiers: number }
    | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
    | { kind: 'key'; type: 'keyDown' | 'keyUp'; key: string; code: string; modifiers: number }
    | { kind: 'text'; text: string }
export interface PageGeometry { documentGeneration: number; viewport: { width: number; height: number; offsetX: number; offsetY: number; scale: number } }
export interface PageImage extends PageGeometry { data: string; mimeType: 'image/jpeg'; pixelWidth: number; pixelHeight: number; capturedAtMs: number; captureDurationMs: number }
/** Private driver port. Callbacks are checked immediately before every input; never wire fields. */
export interface PageViewDriver {
    capture(tabId: TabId, validate: () => void, quality: number, maxDimension: number): Promise<PageImage>
    input(tabId: TabId, frame: PageGeometry, event: PageInput, validate: () => void): Promise<void>
    release(tabId: TabId): Promise<void>
}
export interface PageViewOpen { schemaVersion: 1; agentSessionId: string; taskId: TaskId; tabId: TabId; runtimeBindingId: string }
export interface PageViewRequest { schemaVersion: 1; viewId: string }
export interface PageInputRequest extends PageViewRequest { frameId: string; leaseEpoch: number; sequence: number; event: PageInput }
export type InputReceipt = { sequence: number; state: 'pending' | 'applied' | 'rejected' | 'unknown' }
export interface PageViewStatus { closed: boolean; draining: boolean; unknown: boolean; lastAccepted: number; lastSettled: number; receipts: InputReceipt[] }
export interface PageViewApi {
    pageViewInfo(auth: AuthContext, req: { schemaVersion: 1; profileId: ProfileId }): Promise<{ schemaVersion: 1; supported: boolean; input: boolean; runtimeBindingId: string }>
    openPageView(auth: AuthContext, req: PageViewOpen): Promise<{ schemaVersion: 1; viewId: string; expiresAtMs: number; input: boolean }>
    getPageFrame(auth: AuthContext, req: PageViewRequest & { statusOnly?: boolean; afterFrameId?: string }): Promise<{ schemaVersion: 1; status: PageViewStatus; frame?: PageImage & { frameId: string; ageMs: number } }>
    dispatchPageInput(auth: AuthContext, req: PageInputRequest): Promise<InputReceipt>
    closePageView(auth: AuthContext, req: PageViewRequest): Promise<PageViewStatus>
}
const id = z.string().min(1).max(256)
const v = z.literal(1)
const modifiers = z.number().int().min(0).max(15)
const coordinate = z.number().finite().min(0).max(32768)
export const pageInputSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pointer'), type: z.enum(['mouseMoved', 'mousePressed', 'mouseReleased']), x: coordinate, y: coordinate,
        button: z.enum(['none', 'left', 'middle', 'right']), buttons: z.number().int().min(0).max(7), clickCount: z.number().int().min(0).max(2), modifiers }).strict(),
    z.object({ kind: z.literal('wheel'), x: coordinate, y: coordinate, deltaX: z.number().finite().min(-4096).max(4096), deltaY: z.number().finite().min(-4096).max(4096), modifiers }).strict(),
    z.object({ kind: z.literal('key'), type: z.enum(['keyDown', 'keyUp']), key: z.string().min(1).max(64), code: z.string().min(1).max(64), modifiers }).strict(),
    z.object({ kind: z.literal('text'), text: z.string().min(1).max(1024) }).strict(),
])
export const pageViewSchemas = {
    pageViewInfo: z.object({ schemaVersion: v, profileId: id }).strict(),
    openPageView: z.object({ schemaVersion: v, agentSessionId: id, taskId: id, tabId: id, runtimeBindingId: id }).strict(),
    getPageFrame: z.object({ schemaVersion: v, viewId: id, statusOnly: z.boolean().optional(), afterFrameId: id.optional() }).strict(),
    dispatchPageInput: z.object({ schemaVersion: v, viewId: id, frameId: id, leaseEpoch: z.number().int().nonnegative(), sequence: z.number().int().positive().safe(), event: pageInputSchema }).strict(),
    closePageView: z.object({ schemaVersion: v, viewId: id }).strict(),
}
