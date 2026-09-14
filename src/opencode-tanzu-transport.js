/** Keep foundation credentials out of the native runtime's redirecting client. */
import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export async function createTransport(credentials, fetchImpl = fetch) {
  const key = randomBytes(32).toString('hex')
  const authorization = Buffer.from(`Bearer ${key}`)
  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '')
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      res.writeHead(401); res.end(); return
    }
    if (req.method !== 'POST' || req.url !== '/openai/v1/chat/completions') {
      res.writeHead(404); res.end(); return
    }
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    req.on('aborted', () => abort.abort())
    try {
      let size = 0
      const chunks = []
      for await (const chunk of req) {
        size += chunk.length
        if (size > 32 * 1024 * 1024) { res.writeHead(413); res.end(); return }
        chunks.push(chunk)
      }
      const { baseURL, apiKey } = credentials()
      const headers = new Headers()
      const blocked = new Set(['host', 'authorization', 'content-length', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...(req.headers.connection ?? '').split(',').map((value) => value.trim().toLowerCase())])
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined && !blocked.has(name)) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
      }
      headers.set('authorization', `Bearer ${apiKey}`)
      headers.set('content-type', 'application/json')
      const upstream = await fetchImpl(`${baseURL}/chat/completions`, {
        method: 'POST', redirect: 'error', signal: abort.signal,
        headers,
        body: Buffer.concat(chunks),
      })
      // Never relay a redirect, even with a custom fetch implementation.
      if (upstream.status >= 300 && upstream.status < 400) throw new Error('Redirect rejected')
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' })
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res)
      else res.end()
    } catch {
      if (res.headersSent) { res.destroy(); return }
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Tanzu request failed. Check credentials, endpoint, TLS trust and network; redirects are not allowed.' } }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  server.unref()
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/openai/v1`, apiKey: key,
    close: () => { server.closeAllConnections(); server.close() },
  }
}
