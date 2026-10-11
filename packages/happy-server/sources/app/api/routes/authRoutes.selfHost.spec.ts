import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

// specs/headless-standalone-server (aplus-dev-studio-desktop) R6, R7, R17.
//
// A self-hosted server is reachable from the internet and belongs to one owner. With the
// hardening env unset every route must behave exactly as before (the cloud server runs
// this same code); with it set, only the owner key may sign in, a signed challenge is
// single-use, and an approved pairing code yields its token exactly once.

type Row = { id: string; publicKey: string; supportsV2?: boolean; response: string | null; responseAccountId: string | null; createdAt: Date };

const { db, state, resetState } = vi.hoisted(() => {
    const state = { terminal: new Map<string, Row>(), account: new Map<string, Row>(), accounts: new Set<string>(), seq: 0 };
    const resetState = () => { state.terminal.clear(); state.account.clear(); state.accounts.clear(); state.seq = 0; };
    const table = (rows: () => Map<string, Row>) => ({
        findUnique: vi.fn(async ({ where }: any) => rows().get(where.publicKey) ?? null),
        upsert: vi.fn(async ({ where, create }: any) => {
            const existing = rows().get(where.publicKey);
            if (existing) return existing;
            const row: Row = { id: `r${++state.seq}`, response: null, responseAccountId: null, createdAt: new Date(), ...create };
            rows().set(where.publicKey, row);
            return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
            const row = [...rows().values()].find((r) => r.id === where.id)!;
            Object.assign(row, data);
            return row;
        }),
        deleteMany: vi.fn(async ({ where }: any) => {
            const row = [...rows().values()].find((r) => r.id === where.id);
            if (!row) return { count: 0 };
            if (where.response?.not === null && row.response === null) return { count: 0 };
            rows().delete(row.publicKey);
            return { count: 1 };
        }),
    });
    const db = {
        account: {
            upsert: vi.fn(async ({ where }: any) => { state.accounts.add(where.publicKey); return { id: `acct-${where.publicKey.slice(0, 6)}` }; }),
        },
        terminalAuthRequest: table(() => state.terminal),
        accountAuthRequest: table(() => state.account),
    };
    return { db, state, resetState };
});

vi.mock("@/storage/db", () => ({ db }));
vi.mock("@/utils/log", () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/app/auth/auth", () => ({ auth: { createToken: vi.fn(async (userId: string) => `token-for-${userId}`), createBrowserSyncToken: vi.fn() } }));

import { authRoutes } from "./authRoutes";
import { readSelfHostAuthPolicy, type SelfHostAuthPolicy } from "@/app/auth/selfHostAuthPolicy";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const owner = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const stranger = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));

function signedBody(keys: tweetnacl.SignKeyPair, challenge = tweetnacl.randomBytes(32)) {
    return { publicKey: b64(keys.publicKey), challenge: b64(challenge), signature: b64(tweetnacl.sign.detached(challenge, keys.secretKey)) };
}

async function createApp(policy?: SelfHostAuthPolicy, now = () => Date.now()) {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate("authenticate", async (request: any) => {
        request.userId = "owner-account";
        request.principal = { kind: "account" };
    });
    authRoutes(typed, policy === undefined ? undefined : { policy, now });
    await typed.ready();
    return typed;
}

const hardened = (): SelfHostAuthPolicy => readSelfHostAuthPolicy({
    HAPPY_SELF_HOST_HARDENING: "1",
    HAPPY_AUTH_ALLOWED_PUBLIC_KEYS: b64(owner.publicKey),
});

beforeEach(() => { resetState(); vi.clearAllMocks(); });

describe("readSelfHostAuthPolicy", () => {
    it("is disabled when nothing is configured", () => {
        expect(readSelfHostAuthPolicy({})).toEqual(expect.objectContaining({ allowedPublicKeysHex: null, hardened: false }));
    });

    it("fails closed on an empty or malformed allowlist", () => {
        expect(() => readSelfHostAuthPolicy({ HAPPY_AUTH_ALLOWED_PUBLIC_KEYS: "" })).toThrow();
        expect(() => readSelfHostAuthPolicy({ HAPPY_AUTH_ALLOWED_PUBLIC_KEYS: "not-a-key" })).toThrow();
        expect(() => readSelfHostAuthPolicy({ HAPPY_AUTH_ALLOWED_PUBLIC_KEYS: `${b64(owner.publicKey)},AAAA` })).toThrow();
    });

    it("refuses hardening without an owner allowlist", () => {
        expect(() => readSelfHostAuthPolicy({ HAPPY_SELF_HOST_HARDENING: "1" })).toThrow();
    });

    it("accepts standard and url-safe base64 keys", () => {
        const urlSafe = b64(stranger.publicKey).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        const policy = readSelfHostAuthPolicy({ HAPPY_AUTH_ALLOWED_PUBLIC_KEYS: `${b64(owner.publicKey)}, ${urlSafe}` });
        expect(policy.allowedPublicKeysHex?.size).toBe(2);
    });
});

describe("authRoutes without self-host hardening", () => {
    it("keeps open sign-in and repeatable challenges", async () => {
        const app = await createApp();
        const body = signedBody(stranger);
        expect((await app.inject({ method: "POST", url: "/v1/auth", payload: body })).statusCode).toBe(200);
        expect((await app.inject({ method: "POST", url: "/v1/auth", payload: body })).statusCode).toBe(200);
    });
});

describe("authRoutes with self-host hardening", () => {
    it("lets only the owner key sign in and creates no account for others", async () => {
        const app = await createApp(hardened());
        const refused = await app.inject({ method: "POST", url: "/v1/auth", payload: signedBody(stranger) });
        expect(refused.statusCode).toBe(403);
        expect(db.account.upsert).not.toHaveBeenCalled();
        expect((await app.inject({ method: "POST", url: "/v1/auth", payload: signedBody(owner) })).json().token).toBeTruthy();
    });

    it("rejects a replayed signed challenge", async () => {
        const app = await createApp(hardened());
        const body = signedBody(owner);
        expect((await app.inject({ method: "POST", url: "/v1/auth", payload: body })).statusCode).toBe(200);
        const replay = await app.inject({ method: "POST", url: "/v1/auth", payload: body });
        expect(replay.statusCode).toBe(401);
        expect(replay.json().token).toBeUndefined();
    });

    it("rejects equivalent base64 spellings of a replayed challenge", async () => {
        const app = await createApp(hardened());
        const body = signedBody(owner);
        expect(body.challenge.endsWith("=")).toBe(true);
        expect((await app.inject({ method: "POST", url: "/v1/auth", payload: body })).statusCode).toBe(200);
        const alternate = { ...body, challenge: body.challenge.replace(/=+$/, "") };
        const replay = await app.inject({ method: "POST", url: "/v1/auth", payload: alternate });
        expect(replay.statusCode).toBe(401);
        expect(replay.json().token).toBeUndefined();
    });

    it("hands out an approved pairing token once, then never again", async () => {
        const app = await createApp(hardened());
        const pairing = b64(tweetnacl.box.keyPair().publicKey);
        await app.inject({ method: "POST", url: "/v1/auth/request", payload: { publicKey: pairing, supportsV2: true } });
        await app.inject({ method: "POST", url: "/v1/auth/response", payload: { publicKey: pairing, response: "sealed" } });

        const first = await app.inject({ method: "POST", url: "/v1/auth/request", payload: { publicKey: pairing } });
        expect(first.json()).toEqual(expect.objectContaining({ state: "authorized", response: "sealed" }));
        const second = await app.inject({ method: "POST", url: "/v1/auth/request", payload: { publicKey: pairing } });
        expect(second.json()).toEqual({ state: "requested" });
    });

    it("expires a pairing code that was not approved in time", async () => {
        let clock = 1_000_000;
        const app = await createApp(hardened(), () => clock);
        const pairing = b64(tweetnacl.box.keyPair().publicKey);
        await app.inject({ method: "POST", url: "/v1/auth/request", payload: { publicKey: pairing } });
        state.terminal.forEach((row) => { row.createdAt = new Date(clock); });
        clock += 11 * 60_000;

        const status = await app.inject({ method: "GET", url: `/v1/auth/request/status?publicKey=${encodeURIComponent(pairing)}` });
        expect(status.json().status).toBe("not_found");
        const approve = await app.inject({ method: "POST", url: "/v1/auth/response", payload: { publicKey: pairing, response: "sealed" } });
        expect(approve.statusCode).toBe(410);
        const poll = await app.inject({ method: "POST", url: "/v1/auth/request", payload: { publicKey: pairing } });
        expect(poll.statusCode).toBe(410);
    });

    it("tells the approver when a code was already approved", async () => {
        const app = await createApp(hardened());
        const pairing = b64(tweetnacl.box.keyPair().publicKey);
        await app.inject({ method: "POST", url: "/v1/auth/request", payload: { publicKey: pairing } });
        await app.inject({ method: "POST", url: "/v1/auth/response", payload: { publicKey: pairing, response: "sealed" } });
        const again = await app.inject({ method: "POST", url: "/v1/auth/response", payload: { publicKey: pairing, response: "other" } });
        expect(again.json()).toEqual({ success: true, alreadyApproved: true });
    });

    it("applies the same single-use rule to account pairing", async () => {
        const app = await createApp(hardened());
        const pairing = b64(tweetnacl.box.keyPair().publicKey);
        await app.inject({ method: "POST", url: "/v1/auth/account/request", payload: { publicKey: pairing } });
        await app.inject({ method: "POST", url: "/v1/auth/account/response", payload: { publicKey: pairing, response: "sealed" } });
        expect((await app.inject({ method: "POST", url: "/v1/auth/account/request", payload: { publicKey: pairing } })).json().state).toBe("authorized");
        expect((await app.inject({ method: "POST", url: "/v1/auth/account/request", payload: { publicKey: pairing } })).json()).toEqual({ state: "requested" });
    });

    it("throttles unauthenticated auth calls per address with Retry-After", async () => {
        const app = await createApp(hardened());
        let last = await app.inject({ method: "POST", url: "/v1/auth", payload: signedBody(stranger) });
        for (let i = 0; i < 40 && last.statusCode !== 429; i++) {
            last = await app.inject({ method: "POST", url: "/v1/auth", payload: signedBody(stranger) });
        }
        expect(last.statusCode).toBe(429);
        expect(Number(last.headers["retry-after"])).toBeGreaterThan(0);
    });

    it("rejects oversized auth fields before verifying them", async () => {
        const app = await createApp(hardened());
        const body = { ...signedBody(owner), challenge: "A".repeat(4096) };
        expect((await app.inject({ method: "POST", url: "/v1/auth", payload: body })).statusCode).toBe(400);
    });
});
