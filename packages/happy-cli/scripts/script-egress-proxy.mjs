import http from 'node:http';
import net from 'node:net';
import { resolve4 } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

const forbidden = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['100.64.0.0', 10],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) forbidden.addSubnet(network, prefix);
const privateAddresses = new net.BlockList();
for (const [network, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]]) privateAddresses.addSubnet(network, prefix);

export async function authorizeDestination(origin, allowedOrigins, privateOrigins, resolve = resolve4) {
  if (!allowedOrigins.includes(origin)) throw new Error('ORIGIN_DENIED');
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error('ORIGIN_DENIED');
  const addresses = net.isIP(url.hostname) ? [url.hostname] : await resolve(url.hostname);
  if (!addresses.length || addresses.some((address) => net.isIP(address) !== 4 || forbidden.check(address)
    || (privateAddresses.check(address) && !privateOrigins.includes(origin)))) throw new Error('ADDRESS_DENIED');
  // Connect to this checked IP; do not perform a second, rebindable DNS lookup.
  return addresses[0];
}

export async function authorizeTunnel(authority, allowedOrigins, privateOrigins, resolve = resolve4) {
  if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(authority)) throw new Error('ORIGIN_DENIED');
  const requested = new URL(`http://${authority}`);
  const origin = allowedOrigins.find((value) => {
    const url = new URL(value);
    return url.hostname === requested.hostname
      && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === Number(requested.port || 80);
  });
  if (!origin) throw new Error('ORIGIN_DENIED');
  return { address: await authorizeDestination(origin, allowedOrigins, privateOrigins, resolve), port: Number(requested.port || 80) };
}

export function startProxy({ allowedOrigins, privateOrigins = [], port = 8080 }) {
  const server = http.createServer(async (request, response) => {
    try {
      const target = new URL(request.url);
      if (target.protocol !== 'http:' || target.username || target.password) throw new Error('ORIGIN_DENIED');
      const address = await authorizeDestination(target.origin, allowedOrigins, privateOrigins);
      const headers = { ...request.headers, host: target.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      delete headers.upgrade;
      headers.connection = 'close';
      const upstream = http.request({ hostname: address, port: target.port || 80, path: target.pathname + target.search,
        method: request.method, headers, timeout: 30000 }, (incoming) => {
        response.writeHead(incoming.statusCode || 502, incoming.headers);
        incoming.pipe(response);
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.on('aborted', () => upstream.destroy());
      response.on('close', () => upstream.destroy());
      request.pipe(upstream);
    } catch {
      response.writeHead(403); response.end('Destination denied');
    }
  });
  server.on('connect', async (request, client, head) => {
    try {
      const target = await authorizeTunnel(request.url, allowedOrigins, privateOrigins);
      const upstream = net.connect({ host: target.address, port: target.port });
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    } catch {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  });
  server.maxConnections = 32;
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.listen(port, '0.0.0.0');
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startProxy({ allowedOrigins: JSON.parse(process.env.SCRIPT_ALLOWED_ORIGINS || '[]'),
    privateOrigins: JSON.parse(process.env.SCRIPT_PRIVATE_ORIGINS || '[]') });
}
