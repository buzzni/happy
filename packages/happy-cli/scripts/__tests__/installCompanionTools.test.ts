import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'install-companion-tools.cjs');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { shouldInstallCompanionTools, shouldInstallUvTools } = require(SCRIPT);

describe('shouldInstallCompanionTools', () => {
    it('installs for a global CLI install', () => {
        expect(shouldInstallCompanionTools({ npm_config_global: 'true' })).toBe(true);
    });

    // A local dependency install must not put two extra binaries on PATH.
    it('skips when the install is not global', () => {
        expect(shouldInstallCompanionTools({})).toBe(false);
        expect(shouldInstallCompanionTools({ npm_config_global: 'false' })).toBe(false);
    });

    // pnpm runs this package's postinstall during a workspace install of the
    // monorepo and leaves npm_config_global unset, so contributors never get
    // the companion CLIs pushed onto their machine by `pnpm install`.
    it('skips a pnpm workspace install, which leaves npm_config_global unset', () => {
        expect(shouldInstallCompanionTools({ npm_config_global: undefined })).toBe(false);
    });

    // cli-smoke-test.yml and the post-publish check in docs/happy-cli-release.md
    // both do a real `npm install -g` of this package. They verify the artifact
    // and must not start depending on two unrelated registries.
    it('skips under CI even for a global install', () => {
        expect(shouldInstallCompanionTools({ npm_config_global: 'true', CI: 'true' })).toBe(false);
    });

    it('treats an empty CI value as not set', () => {
        expect(shouldInstallCompanionTools({ npm_config_global: 'true', CI: '' })).toBe(true);
    });

    // `CI=false` is how people explicitly say "this is not CI"; reading it as a
    // CI marker would silently withhold the companion CLIs from a real install.
    it('treats CI=false and CI=0 as not CI', () => {
        expect(shouldInstallCompanionTools({ npm_config_global: 'true', CI: 'false' })).toBe(true);
        expect(shouldInstallCompanionTools({ npm_config_global: 'true', CI: '0' })).toBe(true);
    });
});

describe('shouldInstallUvTools', () => {
    it('installs when the user runs the install themselves', () => {
        expect(shouldInstallUvTools({})).toBe(true);
    });

    // npm's global prefix is shared, so codex-multi-auth lands next to happy
    // either way. uv resolves its tool directory from HOME, which sudo points
    // at root — claude-swap would install somewhere the real user cannot reach
    // while the log still claims success.
    it('skips under sudo, where uv would install into root\'s home', () => {
        expect(shouldInstallUvTools({ SUDO_USER: 'justin' })).toBe(false);
    });
});
