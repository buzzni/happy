#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on native Windows x64');
const systemRoot = process.env.SystemRoot;
if (!systemRoot || !/^[A-Za-z]:\\/.test(systemRoot) || path.resolve(systemRoot) !== systemRoot) throw new Error('Invalid SystemRoot');
const compiler = path.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const source = path.resolve(__dirname, '../native/windowsUserProtection.cs');
const output = path.resolve(process.argv[2] || path.join(__dirname, '../native/windows-x64/user-protection.exe'));
fs.mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Security.dll',
  '/reference:System.Web.Extensions.dll', '/out:' + output, source, path.join(path.dirname(source), 'windowsPrivateFileRead.cs'),
  path.join(path.dirname(source), 'windowsPrivateFilePublish.cs')], { stdio: 'inherit', shell: false });
if (result.error) throw new Error('Windows credential helper compiler could not start');
if (result.status !== 0) process.exit(result.status || 1);
fs.writeFileSync(path.join(path.dirname(output), 'user-protection.json'), JSON.stringify({
  version: 1, sha256: createHash('sha256').update(fs.readFileSync(output)).digest('hex'),
}));
console.log(output);
