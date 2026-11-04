import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { enableNoStoreApiResponses } from "./enableNoStoreApiResponses";

async function build() {
    const app = fastify();
    enableNoStoreApiResponses(app as never);
    app.get("/v1/account/profile", async () => ({ id: "u" }));
    app.get("/v2/sessions", async () => ({ sessions: [] }));
    app.get("/v3/sessions/s/messages", async () => ({ messages: [] }));
    app.get("/v1/unauthorized", async (_request, reply) => reply.code(401).send({ error: "Missing authorization header" }));
    app.get("/v1/own-policy", async (_request, reply) => reply.header("Cache-Control", "private, max-age=60").send({ ok: true }));
    // Routes that answer with reply.send() directly must not race the header write.
    app.get("/v1/direct-send", (_request, reply) => { reply.send({ ok: true }); });
    app.get("/v1/preview/m/3000/", async () => "preview body");
    app.get("/v1/updates/", async () => "socket");
    app.get("/v1/managed-updates/", async () => "socket");
    app.get("/health", async () => ({ ok: true }));
    return app;
}

describe("enableNoStoreApiResponses", () => {
    it("marks authenticated API responses, including errors and unknown routes, as not storable", async () => {
        const app = await build();
        for (const url of ["/v1/account/profile", "/v2/sessions", "/v3/sessions/s/messages", "/v1/unauthorized", "/v1/direct-send", "/v1/no-such-route"]) {
            const response = await app.inject({ method: "GET", url });
            expect(response.headers["cache-control"], url).toBe("no-store");
        }
    });

    it("keeps a cache policy the route set itself", async () => {
        const app = await build();
        const response = await app.inject({ method: "GET", url: "/v1/own-policy" });
        expect(response.headers["cache-control"]).toBe("private, max-age=60");
    });

    it("marks encoded API routes as not storable", async () => {
        const app = await build();
        for (const url of ["/v%31/account/profile", "/%761/account/profile", "/v%32/sessions", "/%763/sessions/s/messages"]) {
            const response = await app.inject({ method: "GET", url });
            expect(response.statusCode, url).toBe(200);
            expect(response.headers["cache-control"], url).toBe("no-store");
        }
        await app.close();
    });

    it("normalizes unmatched paths without decoding their query strings", async () => {
        const app = await build();
        for (const url of ["/v%31/no-such-route", "/%761/no-such-route?invalid=%FF", "/v%32/no-such-route", "/%763/no-such-route"]) {
            const response = await app.inject({ method: "GET", url });
            expect(response.statusCode, url).toBe(404);
            expect(response.headers["cache-control"], url).toBe("no-store");
        }
        await app.close();
    });

    it("preserves route overrides for encoded API paths", async () => {
        const app = await build();
        const response = await app.inject({ method: "GET", url: "/v%31/own-policy" });
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("private, max-age=60");
        await app.close();
    });

    it("preserves passthrough exclusions for encoded routes and unmatched paths", async () => {
        const app = await build();
        for (const url of ["/v%31/pre%76iew/m/3000/", "/%761/up%64ates/", "/v%31/managed%2Dupdates/", "/%68ealth"]) {
            const response = await app.inject({ method: "GET", url });
            expect(response.statusCode, url).toBe(200);
            expect(response.headers["cache-control"], url).toBeUndefined();
        }
        for (const url of ["/v%31/preview/m/3000/missing", "/%761/updates?invalid=%FF", "/v%31/managed-updates/missing"]) {
            const response = await app.inject({ method: "GET", url });
            expect(response.statusCode, url).toBe(404);
            expect(response.headers["cache-control"], url).toBeUndefined();
        }
        await app.close();
    });

    it("leaves the preview relay, socket paths and non-API routes alone", async () => {
        const app = await build();
        for (const url of ["/v1/preview/m/3000/", "/v1/updates/", "/v1/managed-updates/", "/health"]) {
            const response = await app.inject({ method: "GET", url });
            expect(response.headers["cache-control"], url).toBeUndefined();
        }
    });
});
