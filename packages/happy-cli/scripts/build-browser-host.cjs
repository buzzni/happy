'use strict';
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
// Headers and (on Windows) node.lib are explicit build inputs; never download or
// select a different ABI in a service installation.
const headers = process.argv[2] && resolve(process.argv[2]);
if (!headers || !existsSync(join(headers, 'node_api.h'))) throw new Error('Pass a Node headers directory containing node_api.h');
if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Build on the target macOS or Windows host');
const output = resolve(process.argv[3] || join(__dirname, '..', 'native', `${process.platform}-${process.arch}`, 'browser-host.node'));
mkdirSync(dirname(output), { recursive: true });
const source = join(__dirname, '..', 'native', 'browserHost.c');
let compiler, args;
if (process.platform === 'darwin') {
    compiler = '/usr/bin/xcrun';
    args = ['clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fvisibility=hidden', '-DNAPI_VERSION=8', '-DNODE_GYP_MODULE_NAME=browser_host',
        '-bundle', '-undefined', 'dynamic_lookup', '-I', headers, source, '-o', output];
} else {
    const library = process.argv[4] && resolve(process.argv[4]);
    if (!library || !existsSync(library)) throw new Error('Pass the target architecture node.lib after the output path');
    compiler = 'cl.exe';
    args = ['/nologo', '/std:c11', '/LD', '/O2', '/W4', '/WX', '/MD', '/DNAPI_VERSION=8', '/DNODE_GYP_MODULE_NAME=browser_host',
        '/I' + headers, source, '/link', library, 'Advapi32.lib', '/OUT:' + output];
}
const result = spawnSync(compiler, args, { stdio: 'inherit', shell: false, cwd: dirname(output) });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log(output);
