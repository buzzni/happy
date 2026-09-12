import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeDestination, authorizeTunnel } from './script-egress-proxy.mjs';

test('resolves and pins only registered public destinations', async () => {
  assert.equal(await authorizeDestination('https://example.com', ['https://example.com'], [], async () => ['93.184.216.34']), '93.184.216.34');
  await assert.rejects(authorizeDestination('https://other.com', ['https://example.com'], [], async () => ['93.184.216.34']), /ORIGIN_DENIED/);
});
test('blocks metadata, loopback, RFC1918, carrier NAT and mixed public/private DNS answers', async () => {
  for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '172.16.0.1', '192.168.0.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1']) {
    await assert.rejects(authorizeDestination('https://feed.test', ['https://feed.test'], [], async () => ['93.184.216.34', address]), /ADDRESS_DENIED/);
  }
});
test('allows private DB destinations only with a separate trusted binding', async () => {
  assert.equal(await authorizeDestination('http://db:8090', ['http://db:8090'], ['http://db:8090'], async () => ['172.18.0.2']), '172.18.0.2');
  await assert.rejects(authorizeDestination('http://db:8090', [], ['http://db:8090'], async () => ['172.18.0.2']), /ORIGIN_DENIED/);
  await assert.rejects(authorizeDestination('http://db:8090', ['http://db:8090'], ['http://db:8090'], async () => ['169.254.169.254']), /ADDRESS_DENIED/);
});
test('supports HTTP CONNECT used by Node fetch without granting a different port or host', async () => {
  assert.deepEqual(await authorizeTunnel('db:8090', ['http://db:8090'], ['http://db:8090'], async () => ['172.18.0.2']), { address: '172.18.0.2', port: 8090 });
  await assert.rejects(authorizeTunnel('db:9090', ['http://db:8090'], ['http://db:8090'], async () => ['172.18.0.2']), /ORIGIN_DENIED/);
  await assert.rejects(authorizeTunnel('user@db:8090', ['http://db:8090'], ['http://db:8090'], async () => ['172.18.0.2']), /ORIGIN_DENIED/);
});
