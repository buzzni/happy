import * as moduleApi from 'node:module'
import { get } from 'node:http'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = new URL('../dist/', import.meta.url)
const distPath = fileURLToPath(dist)
const entry = new URL('index.mjs', dist)

function readSnapshot(port, token) {
  return new Promise((resolve, reject) => {
    const request = get({
      hostname: '127.0.0.1', port, path: '/modules', agent: false,
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(1750),
    }, async response => {
      const size = Number(response.headers['content-length'])
      if (response.statusCode !== 200 || !(size > 0 && size <= 32 * 1024 * 1024)) {
        response.resume()
        resolve(null)
        return
      }
      try {
        const chunks = []
        let bytes = 0
        for await (const chunk of response) {
          bytes += chunk.length
          if (bytes > size) throw new Error('Invalid resident snapshot length')
          chunks.push(chunk)
        }
        if (bytes !== size) throw new Error('Incomplete resident snapshot')
        resolve(new Map(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
      } catch (error) { reject(error) }
    })
    request.once('error', reject)
  })
}

async function attachResidentModules(descriptor) {
  if (!descriptor || typeof moduleApi.registerHooks !== 'function') return
  try {
    const { version, port, token } = JSON.parse(descriptor)
    if (version === 1 && Number.isInteger(port) && port > 0 && port <= 65535 && /^[a-f0-9]{64}$/.test(token)) {
      const startedAt = performance.now()
      const snapshot = await readSnapshot(port, token)
      if (typeof snapshot?.get('index.mjs') === 'string') {
        moduleApi.registerHooks({
          resolve(specifier, context, nextResolve) {
            if (specifier.startsWith(dist.href)
              || (specifier.startsWith('./') && context.parentURL?.startsWith(dist.href))) {
              const target = new URL(specifier, context.parentURL)
              if (snapshot.has(relative(distPath, fileURLToPath(target)))) return { url: target.href, shortCircuit: true }
            }
            return nextResolve(specifier, context)
          },
          load(url, context, nextLoad) {
            if (url.startsWith(dist.href) && url.endsWith('.mjs')) {
              const source = snapshot.get(relative(distPath, fileURLToPath(url)))
              if (typeof source === 'string') return { format: 'module', source, shortCircuit: true }
            }
            return nextLoad(url, context)
          },
        })
        console.error('[timing] resident Happy modules ready in ' + Math.round(performance.now() - startedAt) + 'ms pid=' + process.pid)
        return snapshot
      }
    }
  } catch {
    // A lost local host must leave the original CLI entry available.
  }
}

const descriptor = process.env.HAPPY_RESIDENT_MODULE_HOST
delete process.env.HAPPY_RESIDENT_MODULE_HOST
await attachResidentModules(descriptor)
process.argv[1] = fileURLToPath(entry)
await import(entry.href)
