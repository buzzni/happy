/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary F8 — `datakey:reseed`,
 * the customer-lane method that moves a strict machine to a new company key.
 *
 * The request reaches the daemon bound to the old machine key, so its sender
 * holds that key; that alone is not enough, because whoever opened the old
 * company key can hold it too. The new key is accepted only from a
 * `company-data-key-generation` declaration signed by the organization key
 * this machine pinned through device approval (design §4-1). The server can
 * relay the declaration but not make one.
 *
 * New sessions stay closed from the check until the daemon restarts on the new
 * key: everything the daemon read once at start still names the old one.
 */
import {
    COMPANY_KEY_RESEED_ERROR_CODES,
    companyKeyReseedParamsSchema,
    machineKeyDigest,
    verifyOrgSetupTokenDocument,
    type CompanyKeyReseedAnswer,
    type CompanyKeyReseedErrorCode,
    type OrgSetupTokenDocument,
} from '@slopus/happy-wire';
import { encodeBase64 } from '@/api/encryption';
import { CompanyKeyReseedError, CompanyKeyReseedUnsettledError, type CompanyKeyTarget } from '@/datakey/machineControl';
import { logger } from '@/ui/logger';

type PinnedOrganization = { publicKey: string; approval: Pick<OrgSetupTokenDocument, 'body'> };

export type CompanyKeyReseedDeps = {
    machineId: string
    /** The organization key pinned through device approval, per company (`deviceEnrollment.orgPin`). */
    pins: { get(companyId: string): Promise<PinnedOrganization | null> }
    /** `reseedCompanyKey` with this daemon's credentials and io. */
    reseed(target: CompanyKeyTarget): Promise<{ changed: boolean; machineKey: Uint8Array }>
    launches: { close(): void; reopen(): void }
    /** Called after a change has been answered; restarts the daemon on the new key. */
    onChanged(): void
}

const refusal = (errorCode: CompanyKeyReseedErrorCode, error: string): CompanyKeyReseedAnswer => ({ success: false, errorCode, error });

export function createCompanyKeyReseedHandler(deps: CompanyKeyReseedDeps) {
    // One at a time, and none after a change: the daemon is about to restart on the new key, and a
    // second request would reopen launches or race the first over the one pending record.
    let busy = false;
    return async (raw: unknown): Promise<CompanyKeyReseedAnswer> => {
        const params = companyKeyReseedParamsSchema.safeParse(raw);
        if (!params.success) return refusal('INVALID_PARAMS', 'datakey:reseed takes { companyId, declaration }');
        const { companyId, declaration } = params.data;

        const pin = await deps.pins.get(companyId).catch(() => null);
        const pinned = pin?.approval.body;
        if (!pin || pinned?.kind !== 'device-approval') {
            return refusal('DEVICE_APPROVAL_REQUIRED', 'This machine has not pinned the organization key through device approval');
        }
        let body: OrgSetupTokenDocument['body'];
        try {
            body = (await verifyOrgSetupTokenDocument(declaration, Buffer.from(pin.publicKey, 'base64url'))).body;
        } catch {
            return refusal('INVALID_DECLARATION', 'The declaration is not signed by the pinned organization key');
        }
        if (body.kind !== 'company-data-key-generation' || body.companyId !== companyId || pinned.companyId !== companyId
            || body.signingGeneration !== pinned.signingGeneration || body.signingKeyId !== pinned.signingKeyId) {
            return refusal('CONTEXT_MISMATCH', 'The declaration is not a company key generation for the pinned organization');
        }

        if (busy) return refusal('BUSY', 'Another company key reseed is running, or the daemon is restarting after one');
        busy = true;
        deps.launches.close();
        let outcome: { changed: boolean; machineKey: Uint8Array };
        try {
            outcome = await deps.reseed({ publicKey: new Uint8Array(Buffer.from(body.dataPublicKey, 'base64url')), generation: body.generation });
        } catch (error) {
            if (error instanceof CompanyKeyReseedUnsettledError) {
                // Clients may already unwrap the new machine key: stay closed and restart, so the
                // next start's resume finishes the pending reseed one way or the other.
                logger.debug('[COMPANY KEY RESEED] Unsettled, restarting to finish it', error);
                deps.onChanged();
                return refusal('RESEED_FAILED', error.message);
            }
            busy = false;
            deps.launches.reopen();
            logger.debug('[COMPANY KEY RESEED] Not moved to the declared company key', error);
            const code = error instanceof CompanyKeyReseedError && (COMPANY_KEY_RESEED_ERROR_CODES as readonly string[]).includes(error.code)
                ? error.code
                : 'RESEED_FAILED';
            return refusal(code, error instanceof Error ? error.message : String(error));
        }
        if (outcome.changed) {
            deps.onChanged();
        } else {
            busy = false;
            deps.launches.reopen();
        }
        return {
            success: true,
            result: { changed: outcome.changed, generation: body.generation, machineKeyDigest: encodeBase64(machineKeyDigest(deps.machineId, outcome.machineKey)) },
        };
    };
}
