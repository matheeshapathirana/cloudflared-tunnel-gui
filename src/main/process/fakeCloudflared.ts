import http from 'node:http'

export interface FakeServerOptions {
  readyConnections?: number
  hostname?: string
  simulate503?: boolean
}

export function createFakeCloudflaredServer(
  _port?: number,
  options: FakeServerOptions = {}
): http.Server {
  const readyConnections = options.readyConnections ?? 1
  const hostname = options.hostname ?? 'test-quick.trycloudflare.com'

  const server = http.createServer((req, res) => {
    if (req.url === '/ready') {
      if (options.simulate503) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Service Unavailable' }))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ readyConnections }))
      }
      return
    }

    if (req.url === '/quicktunnel') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ hostname }))
      return
    }

    res.writeHead(404)
    res.end()
  })

  return server
}
