import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyArchive, validateProfile } from './build-reservation-runtime-image.mjs';
test('rejects altered archive bytes and mutable or unsupported runtime profiles before extraction/build', () => {
  const bytes = Buffer.from('verified native CLI archive');
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  assert.doesNotThrow(() => verifyArchive(bytes, integrity));
  assert.throws(() => verifyArchive(Buffer.from('substituted bytes'), integrity), /INTEGRITY/);
  assert.throws(() => validateProfile({ version: 1, baseImage: 'node:latest', artifacts: { arm64: {} } }, 'arm64'), /PROFILE/);
  assert.throws(() => validateProfile({ version: 1, baseImage: 'node@sha256:' + 'a'.repeat(64), artifacts: {} }, 'amd64'), /PROFILE/);
});
