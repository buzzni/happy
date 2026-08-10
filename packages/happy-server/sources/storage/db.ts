import { PrismaClient } from "@prisma/client";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";
import * as fs from "fs";
import * as path from "path";
import { buildAppDatabaseUrl } from "./databaseUrl";

let pgliteInstance: PGlite | null = null;

type WebAssemblyModuleCtor = new (bytes: Buffer) => WebAssembly.Module;

function getWebAssemblyModuleCtor(): WebAssemblyModuleCtor | null {
    const moduleCtor = (globalThis as { WebAssembly?: { Module?: unknown } }).WebAssembly?.Module;
    return typeof moduleCtor === "function"
        ? (moduleCtor as WebAssemblyModuleCtor)
        : null;
}

function findPGliteWasm(): { wasmModule: WebAssembly.Module; fsBundle: Blob } | null {
    const wasmModuleCtor = getWebAssemblyModuleCtor();
    if (!wasmModuleCtor) {
        return null;
    }
    const searchPaths = [
        process.cwd(),
        path.dirname(process.execPath),
    ];
    for (const dir of searchPaths) {
        const wasmPath = path.join(dir, "pglite.wasm");
        const dataPath = path.join(dir, "pglite.data");
        if (fs.existsSync(wasmPath) && fs.existsSync(dataPath)) {
            const wasmModule = new wasmModuleCtor(fs.readFileSync(wasmPath));
            const fsBundle = new Blob([fs.readFileSync(dataPath)]);
            return { wasmModule, fsBundle };
        }
    }
    return null;
}

function createClient(): PrismaClient {
    const provider = process.env.DB_PROVIDER || "postgres";

    if (provider === "pglite") {
        const pgliteDir = process.env.PGLITE_DIR || "./data/pglite";
        const wasmOpts = findPGliteWasm();
        if (wasmOpts) {
            pgliteInstance = new PGlite({ dataDir: pgliteDir, ...wasmOpts });
        } else {
            pgliteInstance = new PGlite(pgliteDir);
        }
        const adapter = new PrismaPGlite(pgliteInstance);
        return new PrismaClient({ adapter } as any);
    }

    // specs/db-pool-socket-timeout — 응답 없는 소켓의 쿼리가 커넥션을 무한히
    // 점유하지 못하게 앱 풀에만 상한을 건다. DATABASE_URL 을 그대로 두는 것이
    // 핵심이다: 컨테이너가 같은 URL 로 `prisma migrate deploy` 를 먼저 돌리고,
    // 큰 테이블 마이그레이션이 끊기면 이후 배포가 막힌다.
    const url = buildAppDatabaseUrl(
        process.env.DATABASE_URL,
        Number(process.env.DATABASE_SOCKET_TIMEOUT_SECONDS ?? 30)
    );
    return url ? new PrismaClient({ datasourceUrl: url }) : new PrismaClient();
}

export const db = createClient();

export function getPGlite(): PGlite | null {
    return pgliteInstance;
}
