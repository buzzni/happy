#!/usr/bin/env node

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEPENDENCY_FIELDS = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies'
];

const EXPECTED_BUNDLED_FILES = [
    'package/node_modules/@slopus/happy-wire/package.json',
    'package/node_modules/@slopus/happy-wire/dist/index.mjs',
    'package/node_modules/zod/package.json',
    'package/node_modules/@paralleldrive/cuid2/package.json',
    'package/node_modules/@paralleldrive/cuid2/node_modules/@noble/hashes/package.json'
];
const EXPECTED_INSTALLED_FILES = [
    'node_modules/@slopus/happy-wire/package.json',
    'node_modules/@slopus/happy-wire/dist/index.mjs',
    'node_modules/zod/package.json',
    'node_modules/@paralleldrive/cuid2/package.json',
    'node_modules/@paralleldrive/cuid2/node_modules/@noble/hashes/package.json'
];
const MAX_PRINTED_ERRORS = 30;

function parseArgs(argv) {
    const args = { artifact: undefined, installSmoke: false };

    for (const arg of argv) {
        if (arg === '--install-smoke') {
            args.installSmoke = true;
        } else if (!args.artifact) {
            args.artifact = arg;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (!args.artifact) {
        throw new Error('Usage: node scripts/guard-publish-artifact.cjs <publish-dir-or-tgz> [--install-smoke]');
    }

    return args;
}

function run(command, args, options = {}) {
    const result = childProcess.spawnSync(command, args, {
        encoding: 'utf8',
        ...options
    });

    if (result.status !== 0) {
        throw new Error([
            `Command failed: ${command} ${args.join(' ')}`,
            result.stdout,
            result.stderr
        ].filter(Boolean).join('\n'));
    }

    return result;
}

function packArtifact(inputPath) {
    const artifactPath = path.resolve(inputPath);

    if (artifactPath.endsWith('.tgz')) {
        return { tarball: artifactPath, cleanup: () => {} };
    }

    const packDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-cli-pack-'));
    const result = run('npm', [
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        packDirectory
    ], { cwd: artifactPath });

    const jsonStart = result.stdout.indexOf('[');
    const jsonEnd = result.stdout.lastIndexOf(']');

    if (jsonStart === -1 || jsonEnd === -1) {
        throw new Error(`Unable to parse npm pack output:\n${result.stdout}`);
    }

    const packed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));
    const filename = packed[0] && packed[0].filename;

    if (!filename) {
        throw new Error(`npm pack did not return a tarball filename:\n${result.stdout}`);
    }

    return {
        tarball: path.join(packDirectory, filename),
        cleanup: () => fs.rmSync(packDirectory, { force: true, recursive: true })
    };
}

function listTarEntries(tarball) {
    return run('tar', ['-tzf', tarball]).stdout
        .split('\n')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function extractTarEntry(tarball, entry) {
    return run('tar', ['-xOzf', tarball, entry]).stdout;
}

function readTarJson(tarball, entry) {
    return JSON.parse(extractTarEntry(tarball, entry));
}

function hasLocalProtocol(spec) {
    return typeof spec === 'string' && /(^|:)workspace:|^file:/.test(spec);
}

function collectMetadataErrors(packageJson) {
    const errors = [];

    for (const field of DEPENDENCY_FIELDS) {
        const dependencies = packageJson[field] || {};

        for (const [name, spec] of Object.entries(dependencies)) {
            if (hasLocalProtocol(spec)) {
                errors.push(`${field}.${name} uses a local-only protocol: ${spec}`);
            }
        }
    }

    const wireSpec = packageJson.dependencies && packageJson.dependencies['@slopus/happy-wire'];

    if (!wireSpec) {
        errors.push('dependencies.@slopus/happy-wire is missing from publish metadata');
    } else if (hasLocalProtocol(wireSpec)) {
        errors.push(`dependencies.@slopus/happy-wire must be a registry version, got ${wireSpec}`);
    }

    return errors;
}

function collectTarErrors(entries) {
    const entrySet = new Set(entries);
    const errors = [];

    for (const entry of entries) {
        if (entry.includes('/../') || entry.startsWith('../') || entry.includes('node_modules/.pnpm')) {
            errors.push(`tarball contains an invalid workspace path: ${entry}`);
        }
    }

    for (const expectedFile of EXPECTED_BUNDLED_FILES) {
        if (!entrySet.has(expectedFile)) {
            errors.push(`tarball is missing bundled file: ${expectedFile}`);
        }
    }

    return errors;
}

function assertProductionDependencyClosure(prefix) {
    const result = childProcess.spawnSync('npm', [
        'ls',
        '--global',
        '--prefix',
        prefix,
        '--all',
        '--omit=dev',
        '--json'
    ], {
        encoding: 'utf8',
        timeout: 30000
    });

    if (result.status === 0) {
        return;
    }

    let problems = [];
    try {
        const report = JSON.parse(result.stdout || '{}');
        problems = Array.isArray(report.problems) ? report.problems : [];
    } catch {
        // Fall through to the bounded command output below.
    }

    const details = problems.length > 0
        ? formatErrors(problems)
        : [result.stderr, result.stdout]
            .filter(Boolean)
            .join('\n')
            .split('\n')
            .slice(0, MAX_PRINTED_ERRORS)
            .join('\n');

    throw new Error(`Production dependency closure failed:\n- ${details || 'npm ls failed without diagnostic output'}`);
}

function assertDaemonRuntimePreflight(cliPath, isolatedEnv) {
    try {
        run(process.execPath, [cliPath, 'daemon', 'preflight'], {
            env: isolatedEnv,
            timeout: 30000
        });
    } catch (error) {
        const details = String(error.message || error)
            .split('\n')
            .slice(0, MAX_PRINTED_ERRORS)
            .join('\n');
        throw new Error(`Daemon runtime preflight failed:\n${details}`);
    }
}

function runInstallSmoke(tarball, packageJson) {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-cli-install-'));
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-cli-smoke-home-'));
    const isolatedEnv = {
        ...process.env,
        HOME: happyHome,
        USERPROFILE: happyHome,
        HAPPY_HOME_DIR: happyHome,
        HAPPY_SERVER_URL: 'http://127.0.0.1:1'
    };

    try {
        run('npm', [
            'install',
            '-g',
            tarball,
            '--prefix',
            prefix,
            '--prefer-online'
        ]);

        const installedRoot = path.join(
            prefix,
            'lib',
            'node_modules',
            ...packageJson.name.split('/')
        );
        const installedPackagePath = path.join(installedRoot, 'package.json');

        if (!fs.existsSync(installedPackagePath)) {
            throw new Error(`Smoke install did not create ${installedPackagePath}`);
        }

        for (const expectedFile of EXPECTED_INSTALLED_FILES) {
            const installedPath = path.join(installedRoot, expectedFile);

            if (!fs.existsSync(installedPath)) {
                throw new Error(`Smoke install did not include bundled file at ${installedPath}`);
            }
        }

        const installedPackage = JSON.parse(fs.readFileSync(installedPackagePath, 'utf8'));

        if (installedPackage.version !== packageJson.version) {
            throw new Error(`Smoke install version mismatch: expected ${packageJson.version}, got ${installedPackage.version}`);
        }

        assertProductionDependencyClosure(prefix);

        const cliVersionOutput = run(process.execPath, [
            path.join(installedRoot, 'bin', 'happy.mjs'),
            '--version'
        ], {
            env: isolatedEnv,
            timeout: 30000
        }).stdout.trim();
        const expectedVersionOutput = `happy version: ${packageJson.version}`;

        if (cliVersionOutput !== expectedVersionOutput) {
            throw new Error(`CLI version output mismatch: expected ${JSON.stringify(expectedVersionOutput)}, got ${JSON.stringify(cliVersionOutput)}`);
        }

        const cliPath = path.join(installedRoot, 'bin', 'happy.mjs');
        assertDaemonRuntimePreflight(cliPath, isolatedEnv);

        run(process.execPath, [
            cliPath,
            'daemon',
            'status'
        ], {
            env: isolatedEnv,
            timeout: 30000
        });
    } finally {
        fs.rmSync(prefix, { force: true, recursive: true });
        fs.rmSync(happyHome, { force: true, recursive: true });
    }
}

function formatErrors(errors) {
    const printed = errors.slice(0, MAX_PRINTED_ERRORS);
    const remaining = errors.length - printed.length;

    if (remaining > 0) {
        printed.push(`... ${remaining} more errors`);
    }

    return printed.join('\n- ');
}

function guardPublishArtifact() {
    const args = parseArgs(process.argv.slice(2));
    const packed = packArtifact(args.artifact);

    try {
        const entries = listTarEntries(packed.tarball);
        const packageJson = readTarJson(packed.tarball, 'package/package.json');
        const errors = [
            ...collectMetadataErrors(packageJson),
            ...collectTarErrors(entries)
        ];

        if (errors.length > 0) {
            throw new Error(`Publish artifact guard failed:\n- ${formatErrors(errors)}`);
        }

        if (args.installSmoke) {
            runInstallSmoke(packed.tarball, packageJson);
        }

        console.log(`OK ${packageJson.name}@${packageJson.version}`);
        console.log(`Tarball: ${packed.tarball}`);
        console.log(`Checked bundled files: ${EXPECTED_BUNDLED_FILES.length}`);
        if (args.installSmoke) {
            console.log('Smoke install: OK');
        }
    } finally {
        packed.cleanup();
    }
}

try {
    guardPublishArtifact();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
