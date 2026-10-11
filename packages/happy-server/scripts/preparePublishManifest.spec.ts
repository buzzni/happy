import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// specs/headless-standalone-server T8: the fork publishes as @buzzni/happy-server. `npm pack`
// keeps `workspace:*` verbatim, so the raw manifest is not installable from the registry.
const { publishManifest } = createRequire(import.meta.url)("./prepare-publish-package.cjs");

const source = {
    name: "happy-server-self-host",
    version: "1.1.11",
    bin: { "happy-server": "./bin/happy-server.cjs" },
    files: ["bin", "index.cjs", "dist", "prisma", "webapp", "package.json", "README.md"],
    scripts: { build: "x", test: "vitest run", postinstall: "prisma generate --schema=prisma/schema.prisma", prepublishOnly: "y" },
    dependencies: { "@slopus/happy-wire": "workspace:*", prisma: "^6.19.2", zod: "^3.0.0" },
    devDependencies: { vitest: "^3.2.0" },
};
const bundledDist = "// ../happy-wire/dist/index.mjs\nexport {}";

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

    it("refuses when the workspace dependency is not actually bundled", () => {
        expect(() => publishManifest(source, "export {}")).toThrow(/happy-wire/);
    });

    it("refuses any other unpublishable dependency specifier", () => {
        const withLocal = { ...source, dependencies: { ...source.dependencies, other: "file:../other" } };
        expect(() => publishManifest(withLocal, bundledDist)).toThrow(/other/);
    });
});
