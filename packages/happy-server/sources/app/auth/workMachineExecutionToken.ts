import * as privacyKit from 'privacy-kit';
import { z } from 'zod';

const service = 'happy-work-machine-execution';
const tokenPrefix = 'wmx_';
const maxLifetimeMs = 15 * 60_000;
const identifier = z.string().trim().min(1).max(200);
const grant = z.object({
    accountId: identifier,
    machineId: identifier,
    deviceId: identifier,
    generation: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
});
const executionClaims = z.discriminatedUnion('purpose', [
    grant.extend({ purpose: z.literal('daemon') }).strict(),
    grant.extend({ purpose: z.literal('session'), sessionId: identifier }).strict(),
]);

export type WorkMachineExecutionClaims = z.infer<typeof executionClaims>;

export async function createWorkMachineExecutionTokenIssuer(seed: string) {
    const generator = await privacyKit.createPersistentTokenGenerator({ service, seed });
    const verifier = await privacyKit.createPersistentTokenVerifier({
        service, publicKey: Uint8Array.from(generator.publicKey),
    });

    return {
        async mint(claims: WorkMachineExecutionClaims, now: number): Promise<string> {
            const validClaims = executionClaims.parse(claims);
            if (validClaims.expiresAt <= now || validClaims.expiresAt - now > maxLifetimeMs) {
                throw new Error('Invalid work machine credential lifetime');
            }
            return tokenPrefix + await generator.new({ extras: validClaims });
        },
        async verify(token: string, purpose: WorkMachineExecutionClaims['purpose'], now: number): Promise<WorkMachineExecutionClaims | null> {
            if (!token.startsWith(tokenPrefix)) return null;
            try {
                const verified = await verifier.verify(token.slice(tokenPrefix.length));
                const parsed = executionClaims.safeParse(verified?.extras);
                if (!parsed.success || parsed.data.purpose !== purpose || parsed.data.expiresAt <= now) return null;
                return parsed.data;
            } catch {
                return null;
            }
        },
    };
}
