#!/usr/bin/env node

// Publishing this package with anything other than npm silently ships a
// broken artifact: pnpm and yarn re-pack the directory themselves and neither
// implements `bundledDependencies`, so the bundled node_modules
// (@slopus/happy-wire and friends) are dropped from the tarball while the
// registry metadata still declares them. npm then skips installing those
// packages from the registry and every fresh install dies with
// ERR_MODULE_NOT_FOUND. This shipped as 1.1.10-aplus.36 and 1.1.10-aplus.44.
//
// This script runs from prepublishOnly and rejects non-npm publishers.

const fs = require('fs');
const path = require('path');

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
const userAgent = process.env.npm_config_user_agent || '';
const tool = userAgent.split('/')[0];

if (tool && tool !== 'npm') {
    console.error(
        [
            `Refusing to publish ${manifest.name} with ${tool}.`,
            '',
            `${tool} re-packs the package without bundledDependencies, producing`,
            'a tarball whose fresh installs crash with ERR_MODULE_NOT_FOUND',
            '(@slopus/happy-wire). Publish through the release workflow instead:',
            '',
            '  git tag happy-cli-v<version> && git push origin happy-cli-v<version>',
            '',
            'or manually with npm only (see docs/happy-cli-release.md):',
            '',
            '  node scripts/prepare-publish-package.cjs --out <dir>',
            '  cd <dir> && npm pack --ignore-scripts',
            '  node scripts/guard-publish-artifact.cjs <tgz> --install-smoke',
            '  npm publish <tgz> --access public --tag latest --ignore-scripts'
        ].join('\n')
    );
    process.exit(1);
}
