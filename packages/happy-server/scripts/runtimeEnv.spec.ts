import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// The installed runtime runs with cwd = package root so it can find migrations and PGlite
// assets. Without this, `happy-server serve` with no DATA_DIR wrote the database into
// node_modules/<package>/data, where the next reinstall deletes it (specs/headless-standalone-server).
const { resolveRuntimeEnv } = createRequire(import.meta.url)("../index.cjs");

describe("resolveRuntimeEnv", () => {
    it("puts the default data directory in the caller's directory", () => {
        expect(resolveRuntimeEnv({}, "/srv/owner").DATA_DIR).toBe(path.resolve("/srv/owner", "data"));
    });

    it("resolves relative data paths against the caller's directory", () => {
        const env = resolveRuntimeEnv({ DATA_DIR: "state", PGLITE_DIR: "state/db" }, "/srv/owner");
        expect(env.DATA_DIR).toBe(path.resolve("/srv/owner", "state"));
        expect(env.PGLITE_DIR).toBe(path.resolve("/srv/owner", "state/db"));
    });

    it("keeps absolute paths and unrelated variables unchanged", () => {
        const env = resolveRuntimeEnv({ DATA_DIR: "/var/lib/saycode", PORT: "3005" }, "/srv/owner");
        expect(env).toEqual({ DATA_DIR: "/var/lib/saycode", PORT: "3005" });
    });
});

describe("forwardTerminationSignals", () => {
    // A service manager stops `happy-server serve` by signalling the bin wrapper. Without
    // forwarding, the wrapper died and the real server kept running as an orphan.
    const { forwardTerminationSignals } = createRequire(import.meta.url)("../index.cjs");

    it("passes SIGTERM, SIGINT and SIGHUP on to the server process", async () => {
        const { EventEmitter } = await import("node:events");
        const parent = new EventEmitter();
        const received: string[] = [];
        const child = { exitCode: null, kill: (signal: string) => { received.push(signal); return true; } };
        forwardTerminationSignals(parent, child);
        parent.emit("SIGTERM");
        parent.emit("SIGINT");
        parent.emit("SIGHUP");
        expect(received).toEqual(["SIGTERM", "SIGINT", "SIGHUP"]);
    });

    it("does nothing once the server has already exited", async () => {
        const { EventEmitter } = await import("node:events");
        const parent = new EventEmitter();
        const received: string[] = [];
        forwardTerminationSignals(parent, { exitCode: 0, kill: (signal: string) => { received.push(signal); return true; } });
        parent.emit("SIGTERM");
        expect(received).toEqual([]);
    });
});
