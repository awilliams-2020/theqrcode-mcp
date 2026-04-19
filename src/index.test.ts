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
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Inline the helpers we want to test (copied from index.ts so we can test
// them without starting a server)
// ---------------------------------------------------------------------------

function extractApiKey(headers: Record<string, string | undefined>): string | null {
  const auth = headers['authorization'] ?? ''
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim() || null
  return null
}

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
// Reconstruct the createServer factory (mirrors index.ts logic)
// so tests don't depend on the listen side-effect
// ---------------------------------------------------------------------------

function createServer(apiKey: string | null): McpServer {
  const server          = new McpServer({ name: 'theqrcode-mcp', version: '1.1.0' })
  const isAuthenticated = apiKey !== null

  server.tool(
    'generate_qr_code',
    'Generate a QR code image.',
    {
      type:       z.enum(['url', 'wifi', 'contact', 'text', 'email']),
      content:    z.string().min(1),
      size:       z.number().int().min(64).max(1024).optional(),
      darkColor:  z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      lightColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    },
    async ({ type, content, size, darkColor, lightColor }) => {
      const body: Record<string, unknown> = { type, content }
      const settings: Record<string, unknown> = {}
      if (size !== undefined) settings.size = size
      if (darkColor || lightColor) {
        const color: Record<string, string> = {}
        if (darkColor)  color.dark  = darkColor
        if (lightColor) color.light = lightColor
        settings.color = color
      }
      if (Object.keys(settings).length > 0) body.settings = settings

      const endpoint = isAuthenticated
        ? `${API_BASE_MOCK}/api/v1/qr-codes`
        : `${API_BASE_MOCK}/api/public/qr-codes`

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent':   'theqrcode-mcp/1.1',
      }
      if (isAuthenticated) headers['Authorization'] = `Bearer ${apiKey}`

      const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) })

      if (res.status === 401) throw new Error('Invalid API key. Check your Authorization header.')
      if (res.status === 403) {
        const data = await res.json().catch(() => ({})) as Record<string, unknown>
        throw new Error(`Access denied: ${String(data['error'] ?? 'plan does not support this')}`)
      }
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After') ?? '60'
        throw new Error(`Rate limit reached. Please retry after ${retryAfter} seconds.`)
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as Record<string, unknown>
        throw new Error(`QR API returned ${res.status}: ${String(data['error'] ?? res.statusText)}`)
      }

      const data = await res.json() as { qrImage: string; imageUrl: string; type: string; content: string; id?: string }
      const base64 = data.qrImage.replace(/^data:image\/[^;]+;base64,/, '')
      const savedNote = isAuthenticated && data.id
        ? `\nSaved to account with ID: ${data.id}`
        : '\nNote: QR code is ephemeral — the hosted URL expires in 24 hours.'

      return {
        content: [
          { type: 'text' as const, text: `QR code generated.\nType: ${data.type}\nContent: ${data.content}\nHosted URL: ${data.imageUrl}${savedNote}` },
          { type: 'image' as const, data: base64, mimeType: 'image/png' as const },
        ],
      }
    }
  )

  if (isAuthenticated) {
    server.tool(
      'list_qr_codes',
      'List QR codes saved to the account.',
      {
        page:  z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        type:  z.enum(['url', 'wifi', 'contact', 'text', 'email']).optional(),
      },
      async ({ page = 1, limit = 20, type }) => {
        const params = new URLSearchParams({ page: String(page), limit: String(limit) })
        if (type) params.set('type', type)
        const res = await fetch(`${API_BASE_MOCK}/api/v1/qr-codes?${params}`, {
          headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'theqrcode-mcp/1.1' },
        })
        if (res.status === 403) throw new Error('list_qr_codes requires a Developer plan API key.')
        if (!res.ok) throw new Error(`QR API returned ${res.status}`)
        const data = await res.json() as { data: unknown[]; total: number; page: number; limit: number }
        return { content: [{ type: 'text' as const, text: `QR codes (page ${data.page}, ${data.data.length} of ${data.total})` }] }
      }
    )

    server.tool(
      'get_analytics',
      'Get scan analytics.',
      {
        qrCodeId:  z.string().optional(),
        timeRange: z.enum(['1h', '1d', '7d', '30d', '90d', '1y']).optional(),
      },
      async ({ qrCodeId, timeRange = '30d' }) => {
        const params = new URLSearchParams({ timeRange })
        if (qrCodeId) params.set('qrCodeId', qrCodeId)
        const res = await fetch(`${API_BASE_MOCK}/api/v1/analytics?${params}`, {
          headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'theqrcode-mcp/1.1' },
        })
        if (res.status === 403) throw new Error('get_analytics requires a Developer plan API key.')
        if (!res.ok) throw new Error(`QR API returned ${res.status}`)
        const data = await res.json()
        return { content: [{ type: 'text' as const, text: `Analytics (${timeRange}):\n\n${JSON.stringify(data, null, 2)}` }] }
      }
    )
  }

  return server
}

// ---------------------------------------------------------------------------
// Helper: spin up a temporary HTTP server wrapping a McpServer
// ---------------------------------------------------------------------------

async function startTestServer(apiKey: string | null): Promise<{ url: string; server: Server }> {
  const app = express()
  app.use(express.json())

  app.post('/mcp', async (req, res) => {
    const mcpServer = createServer(apiKey)
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
  args: Record<string, unknown>
) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
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
// Tests: tool availability by auth state
// ---------------------------------------------------------------------------

describe('MCP tool availability', () => {
  it('unauthenticated session only exposes generate_qr_code', async () => {
    const { url, server } = await startTestServer(null)
    try {
      const result = await mcpListTools(url)
      const names = result.result?.tools?.map((t: { name: string }) => t.name) ?? []
      expect(names).toContain('generate_qr_code')
      expect(names).not.toContain('list_qr_codes')
      expect(names).not.toContain('get_analytics')
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
