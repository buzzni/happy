import { describe, expect, it } from "vitest";
import { resolveLogLevel } from "./logLevel";

describe("resolveLogLevel", () => {
    // specs/happy-server-log-volume — 레벨이 'debug' 로 하드코딩돼 있어 hot path
    // 로그를 debug 로 강등해도 프로덕션에서 그대로 출력됐다. 기본은 info 로 두고
    // 조사할 때만 LOG_LEVEL 로 되살린다.
    it("defaults to info", () => {
        expect(resolveLogLevel(undefined)).toBe("info");
    });

    it("honours an explicit level", () => {
        expect(resolveLogLevel("debug")).toBe("debug");
        expect(resolveLogLevel("warn")).toBe("warn");
    });

    it("falls back to info for an empty or unknown value", () => {
        expect(resolveLogLevel("")).toBe("info");
        expect(resolveLogLevel("chatty")).toBe("info");
    });

    it("rejects silent, which pino.multistream cannot accept as a stream level", () => {
        expect(resolveLogLevel("silent")).toBe("info");
        expect(resolveLogLevel("fatal")).toBe("fatal");
    });
});
