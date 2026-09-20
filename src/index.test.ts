/**
 * MCP server tests.
 *
 * Strategy: spin up the Express app on a random port, send real HTTP requests,
 * and mock the upstream QR API using vitest's fetch interception.
 * This tests the full auth/routing/tool-registration logic end-to-end
 * without needing the real theqrcode.io backend.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Server } from 'http'

// ---------------------------------------------------------------------------
// Unit tests: extractApiKey
// ---------------------------------------------------------------------------

describe('extractApiKey', () => {
  it('returns null when no Authorization header', () => {
    expect(extractApiKey({})).toBeNull()
  })

  it('returns null for empty bearer', () => {
    expect(extractApiKey({ authorization: 'Bearer ' })).toBeNull()
  })

  it('returns null for non-Bearer schemes', () => {
    expect(extractApiKey({ authorization: 'Basic abc123' })).toBeNull()
  })

  it('extracts key from valid Bearer token', () => {
    expect(extractApiKey({ authorization: 'Bearer tqc_sk_live_abc123' }))
      .toBe('tqc_sk_live_abc123')
  })

  it('trims whitespace from the extracted key', () => {
    expect(extractApiKey({ authorization: 'Bearer   tqc_sk_live_abc123  ' }))
      .toBe('tqc_sk_live_abc123')
  })
})

// ---------------------------------------------------------------------------
// Integration tests: MCP server tool routing
// ---------------------------------------------------------------------------

// We need to import the createServer factory separately.
// Since index.ts calls app.listen at the top level, we can't import it directly.
// Instead we reconstruct the minimal server factory here, which mirrors
// the production logic — keeping tests tightly coupled to the real behaviour.

const API_BASE_MOCK = 'http://mock-api'

/**
 * The SHIPPING server, not a copy of it.
 *
 * This file used to re-implement createServer and every helper it needed, so
 * its 41 assertions ran against a replica that drifted from the real thing: the
 * User-Agent assertion still read 1.2 after the server shipped 1.3, and a test
 * asserting that `email` required an API key kept passing for hours after that
 * gate was removed. A test that cannot fail when the product changes is not a
 * test.
 *
 * `index.ts` reads QR_API_BASE once, at import, so it is pointed at the mock
 * first; its `app.listen` is skipped under NODE_ENV=test, which vitest sets.
 */
process.env.QR_API_BASE = API_BASE_MOCK
const {
  createServer,
  apiHeaders,
  formatShareLinkLine,
  normalizeListPagination,
  defaultQrNameForMcp,
  extractApiKey: extractApiKeyFromRequest,
  extractClientIP: extractClientIPFromRequest,
} = await import('./index.js')

/** The real pair take an express Request; the tests speak in header bags. */
const extractApiKey = (headers: Record<string, string | undefined>) =>
  extractApiKeyFromRequest({ headers } as never)
const extractClientIP = (headers: Record<string, string | undefined>) =>
  extractClientIPFromRequest({ headers } as never)

// Upstream response queue.
// Only non-localhost fetch calls (MCP server → upstream API) consume from this queue.
// Localhost calls (test → Express) always pass through to realFetch.
const realFetch = globalThis.fetch

type MockResponse = {
  ok: boolean
  status: number
  headers: { get: (h: string) => string | null }
  json: () => Promise<unknown>
}
const upstreamQueue: MockResponse[] = []
const upstreamCalls: Array<{ url: string; opts: RequestInit | undefined }> = []

vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, opts?: RequestInit) => {
  const urlStr = url.toString()
  if (urlStr.startsWith('http://localhost')) {
    return realFetch(url as string, opts)
  }
  upstreamCalls.push({ url: urlStr, opts })
  const next = upstreamQueue.shift()
  if (!next) throw new Error(`No upstream mock queued for fetch to ${urlStr}`)
  return next
}))

function makeMockQrResponse(overrides: Record<string, unknown> = {}) {
  return {
    qrImage: 'data:image/png;base64,iVBORw0KGgo=',
    imageUrl: 'https://theqrcode.io/api/public/qr-codes/view/abc123',
    type: 'url',
    content: 'https://example.com',
    id: 'qr_test_123',
    ...overrides,
  }
}

function mockFetchOk(body: unknown, status = 200) {
  upstreamQueue.push({
    ok:      status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json:    async () => body,
  })
}

function mockFetchError(status: number, body: unknown = { error: 'error' }) {
  upstreamQueue.push({
    ok:      false,
    status,
    headers: { get: (h: string) => h === 'Retry-After' ? '60' : null },
    json:    async () => body,
  })
}

// ---------------------------------------------------------------------------
// Helper: spin up a temporary HTTP server wrapping a McpServer
// ---------------------------------------------------------------------------

async function startTestServer(apiKey: string | null): Promise<{ url: string; server: Server }> {
  const app = express()
  app.use(express.json())

  app.post('/mcp', async (req, res) => {
    const mcpServer = createServer(apiKey, extractClientIP(req.headers as Record<string, string | undefined>))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { transport.close().catch(() => {}); mcpServer.close().catch(() => {}) })
    await mcpServer.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number }
      resolve({ url: `http://localhost:${addr.port}`, server })
    })
  })
}

async function stopServer(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()))
}

// ---------------------------------------------------------------------------
// MCP protocol helpers
// ---------------------------------------------------------------------------

async function mcpListTools(baseUrl: string) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  })
  const text = await res.text()
  // StreamableHTTP may return SSE or JSON — parse the data line if SSE
  const jsonLine = text.split('\n').find(l => l.startsWith('data:'))
  const raw = jsonLine ? jsonLine.slice(5) : text
  return JSON.parse(raw)
}

async function mcpCallTool(
  baseUrl: string,
  name: string,
  args: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extraHeaders },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const text = await res.text()
  const jsonLine = text.split('\n').find(l => l.startsWith('data:'))
  const raw = jsonLine ? jsonLine.slice(5) : text
  return JSON.parse(raw)
}


// ---------------------------------------------------------------------------
// Tests: client IP forwarding
//
// Traefik terminates every real session at mcp.theqrcode.io and writes
// x-real-ip / x-forwarded-for. Unless those are passed through to the QR API,
// the outbound fetch carries no forwarded header, Next.js fills one in from the
// peer socket, and every MCP user in the world collapses into one container IP
// — one shared rate-limit bucket and one shared 24h block key.
// ---------------------------------------------------------------------------

describe('extractClientIP', () => {
  it('prefers x-real-ip', () => {
    expect(extractClientIP({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9' }))
      .toBe('203.0.113.7')
  })

  it('takes the RIGHTMOST x-forwarded-for hop, not the client-prepended first', () => {
    expect(extractClientIP({ 'x-forwarded-for': '1.2.3.4, 198.51.100.9' })).toBe('198.51.100.9')
  })

  it('trims surrounding whitespace', () => {
    expect(extractClientIP({ 'x-real-ip': '  203.0.113.7  ' })).toBe('203.0.113.7')
  })

  it('returns null when no forwarded header is present', () => {
    expect(extractClientIP({})).toBeNull()
    expect(extractClientIP({ 'x-real-ip': '   ' })).toBeNull()
  })
})

describe('apiHeaders', () => {
  it('forwards the client IP when there is one', () => {
    expect(apiHeaders('203.0.113.7')['X-Forwarded-For']).toBe('203.0.113.7')
  })

  it('omits the header entirely rather than asserting a guess', () => {
    expect(apiHeaders(null)).not.toHaveProperty('X-Forwarded-For')
  })

  it('keeps the User-Agent and merges extras', () => {
    const h = apiHeaders('203.0.113.7', { Authorization: 'Bearer k' })
    expect(h['User-Agent']).toBe('theqrcode-mcp/1.3')
    expect(h['Authorization']).toBe('Bearer k')
  })
})

describe('client IP reaches the QR API', () => {
  beforeEach(() => {
    upstreamQueue.length = 0
    upstreamCalls.length = 0
  })

  it('forwards the end user IP on an unauthenticated generate', async () => {
    mockFetchOk(makeMockQrResponse({ id: undefined }))
    const { url, server } = await startTestServer(null)
    try {
      await mcpCallTool(
        url,
        'generate_qr_code',
        { type: 'url', name: 'test', content: 'https://example.com' },
        { 'X-Real-IP': '203.0.113.7' }
      )
      const headers = upstreamCalls[0]?.opts?.headers as Record<string, string>
      expect(headers['X-Forwarded-For']).toBe('203.0.113.7')
    } finally {
      await stopServer(server)
    }
  })

  it('forwards the end user IP on an authenticated tool call', async () => {
    mockFetchOk({ data: [], pagination: { page: 1, limit: 20, total: 0 } })
    const { url, server } = await startTestServer('tqc_sk_live_mykey')
    try {
      await mcpCallTool(url, 'list_qr_codes', {}, { 'X-Real-IP': '198.51.100.9' })
      const headers = upstreamCalls[0]?.opts?.headers as Record<string, string>
      expect(headers['X-Forwarded-For']).toBe('198.51.100.9')
      expect(headers['Authorization']).toBe('Bearer tqc_sk_live_mykey')
    } finally {
      await stopServer(server)
    }
  })

  it('sends no forwarded header when the caller did not come through Traefik', async () => {
    mockFetchOk(makeMockQrResponse({ id: undefined }))
    const { url, server } = await startTestServer(null)
    try {
      await mcpCallTool(url, 'generate_qr_code', {
        type: 'url', name: 'test', content: 'https://example.com',
      })
      const headers = upstreamCalls[0]?.opts?.headers as Record<string, string>
      expect(headers).not.toHaveProperty('X-Forwarded-For')
    } finally {
      await stopServer(server)
    }
  })
})

// ---------------------------------------------------------------------------
// Tests: tool availability by auth state
// ---------------------------------------------------------------------------

describe('MCP tool availability', () => {
  // Directory crawlers (Glama, MCP registries) probe tools/list without a key.
  // The paid tools must be visible there, and refuse only when actually called.
  it('unauthenticated session still advertises all three tools', async () => {
    const { url, server } = await startTestServer(null)
    try {
      const result = await mcpListTools(url)
      const names = result.result?.tools?.map((t: { name: string }) => t.name) ?? []
      expect(names).toContain('generate_qr_code')
      expect(names).toContain('list_qr_codes')
      expect(names).toContain('get_analytics')
    } finally {
      await stopServer(server)
    }
  })

  it('unauthenticated call to a paid tool is refused with a plan message', async () => {
    const { url, server } = await startTestServer(null)
    try {
      for (const tool of ['list_qr_codes', 'get_analytics']) {
        const result = await mcpCallTool(url, tool, {})
        const text = JSON.stringify(result)
        expect(text).toContain('requires a Developer plan API key')
      }
    } finally {
      await stopServer(server)
    }
  })

  it('authenticated session exposes all three tools', async () => {
    const { url, server } = await startTestServer('tqc_sk_live_test123')
    try {
      const result = await mcpListTools(url)
      const names = result.result?.tools?.map((t: { name: string }) => t.name) ?? []
      expect(names).toContain('generate_qr_code')
      expect(names).toContain('list_qr_codes')
      expect(names).toContain('get_analytics')
    } finally {
      await stopServer(server)
    }
  })
})

// ---------------------------------------------------------------------------
// Tests: generate_qr_code routing
// ---------------------------------------------------------------------------

describe('generate_qr_code — routing', () => {
  beforeEach(() => {
    upstreamQueue.length = 0
    upstreamCalls.length = 0
  })

  it('unauthenticated → calls public endpoint', async () => {
    mockFetchOk(makeMockQrResponse({ id: undefined }))
    const { url, server } = await startTestServer(null)
    try {
      await mcpCallTool(url, 'generate_qr_code', { type: 'url', content: 'https://example.com' })
      const { url: calledUrl, opts: calledOpts } = upstreamCalls[0]
      expect(calledUrl).toBe(`${API_BASE_MOCK}/api/public/qr-codes`)
      expect((calledOpts?.headers as Record<string, string>)?.['Authorization']).toBeUndefined()
    } finally {
      await stopServer(server)
    }
  })

  it('authenticated → calls v1 endpoint with Authorization header', async () => {
    mockFetchOk(makeMockQrResponse())
    const { url, server } = await startTestServer('tqc_sk_live_mykey')
    try {
      await mcpCallTool(url, 'generate_qr_code', { type: 'url', content: 'https://example.com' })
      const { url: calledUrl, opts: calledOpts } = upstreamCalls[0]
      expect(calledUrl).toBe(`${API_BASE_MOCK}/api/v1/qr-codes`)
      expect((calledOpts?.headers as Record<string, string>)?.['Authorization']).toBe('Bearer tqc_sk_live_mykey')
      const parsed = JSON.parse((calledOpts?.body as string) ?? '{}') as Record<string, unknown>
      expect(parsed.name).toBe('MCP url: https://example.com')
      expect(parsed.type).toBe('url')
      expect(parsed.content).toBe('https://example.com')
    } finally {
      await stopServer(server)
    }
  })

  it('authenticated → uses trimmed name when provided', async () => {
    mockFetchOk(makeMockQrResponse())
    const { url, server } = await startTestServer('tqc_sk_live_mykey')
    try {
      await mcpCallTool(url, 'generate_qr_code', {
        type:    'url',
        content: 'https://example.com',
        name:    '  My label  ',
      })
      const parsed = JSON.parse((upstreamCalls[0].opts?.body as string) ?? '{}') as Record<string, unknown>
      expect(parsed.name).toBe('My label')
    } finally {
      await stopServer(server)
    }
  })

  it('unauthenticated result contains ephemeral note', async () => {
    mockFetchOk(makeMockQrResponse({ id: undefined }))
    const { url, server } = await startTestServer(null)
    try {
      const result = await mcpCallTool(url, 'generate_qr_code', { type: 'url', content: 'https://example.com' })
      const text = result.result?.content?.find((c: { type: string }) => c.type === 'text')?.text ?? ''
      expect(text).toContain('ephemeral')
    } finally {
      await stopServer(server)
    }
  })

  it('authenticated result contains saved account ID', async () => {
    mockFetchOk(makeMockQrResponse({ id: 'qr_test_123' }))
    const { url, server } = await startTestServer('tqc_sk_live_mykey')
    try {
      const result = await mcpCallTool(url, 'generate_qr_code', { type: 'url', content: 'https://example.com' })
      const text = result.result?.content?.find((c: { type: string }) => c.type === 'text')?.text ?? ''
      expect(text).toContain('qr_test_123')
    } finally {
      await stopServer(server)
    }
  })

  it('authenticated v1 without imageUrl uses shortUrl in message when present', async () => {
    mockFetchOk(
      makeMockQrResponse({
        imageUrl: undefined,
        shortUrl: 'https://short.example/track/xyz',
      })
    )
    const { url, server } = await startTestServer('tqc_sk_live_mykey')
    try {
      const result = await mcpCallTool(url, 'generate_qr_code', { type: 'url', content: 'https://example.com' })
      const text = result.result?.content?.find((c: { type: string }) => c.type === 'text')?.text ?? ''
      expect(text).toContain('Short URL (tracking): https://short.example/track/xyz')
      expect(text).not.toMatch(/undefined/i)
    } finally {
      await stopServer(server)
    }
  })

  it('authenticated v1 without imageUrl or shortUrl avoids undefined in message', async () => {
    mockFetchOk(
      makeMockQrResponse({
        imageUrl: undefined,
        shortUrl: null,
        id:       'qr_static',
      })
    )
    const { url, server } = await startTestServer('tqc_sk_live_mykey')
    try {
      const result = await mcpCallTool(url, 'generate_qr_code', { type: 'url', content: 'https://example.com' })
      const text = result.result?.content?.find((c: { type: string }) => c.type === 'text')?.text ?? ''
      expect(text).toContain('not returned by the API')
      expect(text).not.toMatch(/undefined/i)
    } finally {
      await stopServer(server)
    }
  })

  it('sends an unauthenticated email type straight upstream, like any other type', async () => {
    // This used to assert the opposite. The email "type" is `mailto:` prepended to
    // the content, so a free user reproduced it byte-for-byte with a text code —
    // the gate was dropped on 2026-09-20 rather than enforced.
    const { url, server } = await startTestServer(null)
    try {
      const result = await mcpCallTool(url, 'generate_qr_code', {
        type:    'email',
        content: 'a@b.com',
      })
      expect(result.error).toBeUndefined()
      expect(upstreamCalls.length).toBe(1)
      expect(JSON.parse((upstreamCalls[0]!.opts?.body as string) ?? '{}')).toMatchObject({ type: 'email' })
    } finally {
      await stopServer(server)
    }
  })

  it('refuses svg without a key, before calling upstream', async () => {
    // The keyless endpoint renders PNG only. Failing here with the reason lets the
    // model retry usefully instead of surfacing an unexplained 400.
    const { url, server } = await startTestServer(null)
    try {
      const result = await mcpCallTool(url, 'generate_qr_code', {
        type:    'url',
        content: 'https://example.com',
        format:  'svg',
      })
      const errText =
        result.error?.message ??
        result.result?.content?.find((c: { type: string }) => c.type === 'text')?.text ??
        ''
      expect(errText).toMatch(/API key/i)
      expect(upstreamCalls.length).toBe(0)
    } finally {
      await stopServer(server)
    }
  })

  it('forwards a requested format on an authenticated call', async () => {
    const { url, server } = await startTestServer('qr_live_key')
    try {
      const result = await mcpCallTool(url, 'generate_qr_code', {
        type:    'url',
        content: 'https://example.com',
        format:  'pdf',
      })
      expect(result.error).toBeUndefined()
      expect(JSON.parse((upstreamCalls[0]!.opts?.body as string) ?? '{}')).toMatchObject({ format: 'pdf' })
    } finally {
      await stopServer(server)
    }
  })
})

// ---------------------------------------------------------------------------
// Tests: error handling
// ---------------------------------------------------------------------------

describe('generate_qr_code — error handling', () => {
  beforeEach(() => {
    upstreamQueue.length = 0
    upstreamCalls.length = 0
  })

  it('surfaces 401 as invalid key message', async () => {
    mockFetchError(401)
    const { url, server } = await startTestServer('tqc_sk_live_badkey')
    try {
      const result = await mcpCallTool(url, 'generate_qr_code', { type: 'url', content: 'https://example.com' })
      const errMsg = result.error?.message ?? result.result?.content?.[0]?.text ?? ''
      expect(errMsg).toMatch(/Invalid API key/i)
    } finally {
      await stopServer(server)
    }
  })

  it('surfaces 429 as rate limit message with retry-after', async () => {
    mockFetchError(429)
    const { url, server } = await startTestServer(null)
    try {
      const result = await mcpCallTool(url, 'generate_qr_code', { type: 'url', content: 'https://example.com' })
      const errMsg = result.error?.message ?? result.result?.content?.[0]?.text ?? ''
      expect(errMsg).toMatch(/rate limit/i)
      expect(errMsg).toMatch(/60/)
    } finally {
      await stopServer(server)
    }
  })

  it('surfaces 403 with descriptive message', async () => {
    mockFetchError(403, { error: 'plan does not support email type' })
    const { url, server } = await startTestServer('tqc_sk_live_starter')
    try {
      const result = await mcpCallTool(url, 'generate_qr_code', { type: 'email', content: 'test@example.com' })
      const errMsg = result.error?.message ?? result.result?.content?.[0]?.text ?? ''
      expect(errMsg).toMatch(/plan does not support email type/i)
    } finally {
      await stopServer(server)
    }
  })
})

// ---------------------------------------------------------------------------
// Tests: list_qr_codes and get_analytics
// ---------------------------------------------------------------------------

describe('extended tools are marked for the Developer-plan gate', () => {
  // theqrcode.io enforces "Developer only" for these two tools by the X-MCP-Tool
  // header: without it the call is indistinguishable from a Pro key's plain REST call.
  beforeEach(() => {
    upstreamQueue.length = 0
    upstreamCalls.length = 0
  })

  it.each([
    ['generate_qr_code', makeMockQrResponse(), { type: 'url', content: 'https://example.com' }],
    ['list_qr_codes', { data: [], total: 0, page: 1, limit: 20 }, {}],
    ['get_analytics', { totalScans: 0 }, {}],
  ])('%s sends X-MCP-Tool naming the tool', async (tool, body, args) => {
    mockFetchOk(body)
    const { url, server } = await startTestServer('tqc_sk_live_dev')
    try {
      await mcpCallTool(url, tool, args)
      const headers = upstreamCalls[0].opts?.headers as Record<string, string>
      expect(headers['X-MCP-Tool']).toBe(tool)
    } finally {
      await stopServer(server)
    }
  })

  it('an anonymous generate is not marked as MCP-authenticated', async () => {
    mockFetchOk(makeMockQrResponse())
    const { url, server } = await startTestServer(null)
    try {
      await mcpCallTool(url, 'generate_qr_code', { type: 'url', content: 'https://example.com' })
      const headers = upstreamCalls[0].opts?.headers as Record<string, string>
      expect(headers).not.toHaveProperty('X-MCP-Tool')
    } finally {
      await stopServer(server)
    }
  })

  it('surfaces the plan MCP rate limit message on an authenticated 429', async () => {
    mockFetchError(429, { error: 'MCP rate limit exceeded (500 requests/hour on your plan). Try again in 60 seconds.' })
    const { url, server } = await startTestServer('tqc_sk_live_pro')
    try {
      const result = await mcpCallTool(url, 'generate_qr_code', { type: 'url', content: 'https://example.com' })
      expect(JSON.stringify(result)).toContain('MCP rate limit exceeded (500 requests/hour')
    } finally {
      await stopServer(server)
    }
  })

  it('surfaces the API\'s own 403 reason', async () => {
    mockFetchError(403, { error: 'The list_qr_codes and get_analytics MCP tools require the Developer plan.' })
    const { url, server } = await startTestServer('tqc_sk_live_pro')
    try {
      const result = await mcpCallTool(url, 'get_analytics', {})
      expect(JSON.stringify(result)).toContain('MCP tools require the Developer plan')
    } finally {
      await stopServer(server)
    }
  })
})

describe('list_qr_codes', () => {
  beforeEach(() => {
    upstreamQueue.length = 0
    upstreamCalls.length = 0
  })

  it('calls correct endpoint with pagination params', async () => {
    mockFetchOk({ data: [], total: 0, page: 1, limit: 10 })
    const { url, server } = await startTestServer('tqc_sk_live_dev')
    try {
      await mcpCallTool(url, 'list_qr_codes', { page: 1, limit: 10 })
      const calledUrl = upstreamCalls[0].url
      expect(calledUrl).toContain('/api/v1/qr-codes')
      expect(calledUrl).toContain('page=1')
      expect(calledUrl).toContain('limit=10')
    } finally {
      await stopServer(server)
    }
  })

  it('passes type filter when provided', async () => {
    mockFetchOk({ data: [], total: 0, page: 1, limit: 20 })
    const { url, server } = await startTestServer('tqc_sk_live_dev')
    try {
      await mcpCallTool(url, 'list_qr_codes', { type: 'url' })
      expect(upstreamCalls[0].url).toContain('type=url')
    } finally {
      await stopServer(server)
    }
  })

  it('parses pagination object from GET /api/v1/qr-codes response', async () => {
    mockFetchOk({
      data: [
        { id: 'qr1', name: 'A', type: 'url', isDynamic: false },
      ],
      pagination: { page: 2, limit: 5, total: 11 },
    })
    const { url, server } = await startTestServer('tqc_sk_live_dev')
    try {
      const result = await mcpCallTool(url, 'list_qr_codes', { page: 2, limit: 5 })
      const text = result.result?.content?.find((c: { type: string }) => c.type === 'text')?.text ?? ''
      expect(text).toContain('page 2')
      expect(text).toContain('of 11')
    } finally {
      await stopServer(server)
    }
  })
})

describe('get_analytics', () => {
  beforeEach(() => {
    upstreamQueue.length = 0
    upstreamCalls.length = 0
  })

  it('calls correct endpoint with timeRange', async () => {
    mockFetchOk({ totalScans: 42 })
    const { url, server } = await startTestServer('tqc_sk_live_dev')
    try {
      await mcpCallTool(url, 'get_analytics', { timeRange: '7d' })
      const calledUrl = upstreamCalls[0].url
      expect(calledUrl).toContain('/api/v1/analytics')
      expect(calledUrl).toContain('timeRange=7d')
    } finally {
      await stopServer(server)
    }
  })

  it('passes qrCodeId filter when provided', async () => {
    mockFetchOk({ totalScans: 5 })
    const { url, server } = await startTestServer('tqc_sk_live_dev')
    try {
      await mcpCallTool(url, 'get_analytics', { qrCodeId: 'qr_abc', timeRange: '30d' })
      expect(upstreamCalls[0].url).toContain('qrCodeId=qr_abc')
    } finally {
      await stopServer(server)
    }
  })

  it('returns formatted analytics text', async () => {
    mockFetchOk({ totalScans: 99, topDevice: 'mobile' })
    const { url, server } = await startTestServer('tqc_sk_live_dev')
    try {
      const result = await mcpCallTool(url, 'get_analytics', { timeRange: '30d' })
      const text = result.result?.content?.find((c: { type: string }) => c.type === 'text')?.text ?? ''
      expect(text).toContain('30d')
      expect(text).toContain('totalScans')
    } finally {
      await stopServer(server)
    }
  })
})
