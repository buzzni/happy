import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// specs/headless-standalone-server T8: the fork publishes as @buzzni/happy-server. `npm pack`
// keeps `workspace:*` verbatim, so the raw manifest is not installable from the registry.
const { publishManifest } = createRequire(import.meta.url)("./prepare-publish-package.cjs");

const source = {
    name: "happy-server-self-host",
    version: "1.1.11",
    repository: { type: "git", url: "https://github.com/slopus/happy" },
    homepage: "https://happy.engineering",
    bugs: "https://github.com/slopus/happy/issues",
    bin: { "happy-server": "./bin/happy-server.cjs" },
    files: ["bin", "index.cjs", "dist", "prisma", "webapp", "package.json", "README.md"],
    scripts: { build: "x", test: "vitest run", postinstall: "prisma generate --schema=prisma/schema.prisma", prepublishOnly: "y" },
    dependencies: { "@slopus/happy-wire": "workspace:*", prisma: "^6.19.2", zod: "^3.0.0" },
    devDependencies: { vitest: "^3.2.0" },
};
const bundledDist = "// ../happy-wire/dist/index.mjs\nexport {}";

function packageFixture() {
    const directory = mkdtempSync(join(tmpdir(), "happy-publish-test-"));
    const root = join(directory, "source");
    const script = join(root, "scripts/prepare-publish-package.cjs");
    mkdirSync(dirname(script), { recursive: true });
    cpSync(fileURLToPath(new URL("./prepare-publish-package.cjs", import.meta.url)), script);
    writeFileSync(join(root, "package.json"), JSON.stringify(source));
    for (const [entry, contents] of Object.entries({
        "bin/happy-server.cjs": "// bin",
        "index.cjs": "// entry",
        "dist/standalone.mjs": bundledDist,
        "prisma/schema.prisma": "// schema",
        "prisma/migrations/marker": "// migration",
        "webapp/index.html": "<html></html>",
        "source-marker": "uncommitted source",
    })) {
        mkdirSync(dirname(join(root, entry)), { recursive: true });
        writeFileSync(join(root, entry), contents);
    }
    return { directory, root, script };
}

describe("prepare-publish-package CLI", () => {
    it.each(["missing", "empty", "option", "source", "ancestor"])("rejects %s output without deleting source files", (kind) => {
        const fixture = packageFixture();
        try {
            const args = kind === "missing" ? ["--out"]
                : kind === "empty" ? ["--out", ""]
                : kind === "option" ? ["--out", "--version", "0.1.0"]
                : ["--out", kind === "source" ? fixture.root : fixture.directory];
            const result = spawnSync(process.execPath, [fixture.script, ...args], { cwd: fixture.root, encoding: "utf8" });
            expect(result.status).toBe(1);
            expect(existsSync(join(fixture.root, "package.json"))).toBe(true);
            expect(readFileSync(join(fixture.root, "source-marker"), "utf8")).toBe("uncommitted source");
            expect(existsSync(join(fixture.root, "dist/standalone.mjs"))).toBe(true);
            expect(result.stderr).toMatch(/usage:|source directory/);
        } finally {
            rmSync(fixture.directory, { recursive: true, force: true });
        }
    });

    it("prepares a complete artifact in a separate output directory", () => {
        const fixture = packageFixture();
        try {
            const out = join(fixture.directory, "artifact");
            const result = spawnSync(process.execPath, [fixture.script, "--out", out, "--version", "0.1.0"], { cwd: fixture.root, encoding: "utf8" });
            expect(result.status, result.stderr).toBe(0);
            expect(JSON.parse(readFileSync(join(out, "package.json"), "utf8"))).toEqual(expect.objectContaining({ name: "@buzzni/happy-server", version: "0.1.0" }));
            expect(existsSync(join(out, "dist/standalone.mjs"))).toBe(true);
            expect(readFileSync(join(fixture.root, "source-marker"), "utf8")).toBe("uncommitted source");
        } finally {
            rmSync(fixture.directory, { recursive: true, force: true });
        }
    });
});

describe("publishManifest", () => {
    it("renames the package, drops dev-only fields and the bundled workspace dependency", () => {
        const manifest = publishManifest(source, bundledDist);
        expect(manifest.name).toBe("@buzzni/happy-server");
        expect(manifest.version).toBe("1.1.11");
        expect(manifest.dependencies).toEqual({ prisma: "^6.19.2", zod: "^3.0.0" });
        expect(manifest.devDependencies).toBeUndefined();
        expect(manifest.scripts).toEqual({ postinstall: "prisma generate --schema=prisma/schema.prisma" });
        expect(manifest.publishConfig).toEqual({ access: "public" });
    });

    it("publishes under its own version line, independent of the upstream package version", () => {
        expect(publishManifest(source, bundledDist, "0.1.0").version).toBe("0.1.0");
        expect(publishManifest(source, bundledDist, "0.2.0-rc.1").version).toBe("0.2.0-rc.1");
    });

    it("points at the repository that builds it, which npm provenance requires", () => {
        const manifest = publishManifest(source, bundledDist, "0.1.0");
        expect(manifest.repository).toEqual({ type: "git", url: "git+https://github.com/buzzni/happy.git", directory: "packages/happy-server" });
        expect(manifest.bugs).toBe("https://github.com/buzzni/happy/issues");
        expect(manifest.homepage).toBe("https://github.com/buzzni/happy");
    });

    it("refuses a publish version that is not semver", () => {
        expect(() => publishManifest(source, bundledDist, "v0.1.0")).toThrow(/version/);
        expect(() => publishManifest(source, bundledDist, "0.1")).toThrow(/version/);
    });

    it("refuses when the workspace dependency is not actually bundled", () => {
        expect(() => publishManifest(source, "export {}")).toThrow(/happy-wire/);
    });

    it("refuses any other unpublishable dependency specifier", () => {
        const withLocal = { ...source, dependencies: { ...source.dependencies, other: "file:../other" } };
        expect(() => publishManifest(withLocal, bundledDist)).toThrow(/other/);
    });
});
