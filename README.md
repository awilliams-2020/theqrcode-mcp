# TheQRCode.io MCP Server

[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/theqrcode-io-mcp)

Generate QR codes — and read their scan analytics — from Claude, Cursor, or any MCP client.

**Remote HTTP server. Nothing to install.** No npm, no Docker, no Python. Point your client at one
URL and ask.

```
https://mcp.theqrcode.io/mcp
```

Listed in the official MCP Registry as **`io.theqrcode/qr-code-generator`**.

---

## Setup

### Claude Desktop

Settings → Developer → Edit Config:

```json
{
  "mcpServers": {
    "theqrcode": {
      "url": "https://mcp.theqrcode.io/mcp"
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "theqrcode": {
      "url": "https://mcp.theqrcode.io/mcp"
    }
  }
}
```

### With an API key (unlocks the analytics tools)

```json
{
  "mcpServers": {
    "theqrcode": {
      "url": "https://mcp.theqrcode.io/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

Any client supporting the MCP spec over streamable HTTP works. Restart the client after editing
config, then just ask: *"Generate a QR code for https://example.com"*.

---

## Tools

Three tools. All three are advertised to every session — including anonymous ones, so directory
crawlers see the real surface — but the two account tools refuse at call time without a key.

### `generate_qr_code` — free, no key

| Param | Type | Required | Notes |
|---|---|---|---|
| `type` | `url` \| `wifi` \| `contact` \| `text` \| `email` | yes | all five free, no key |
| `content` | string | yes | the data to encode |
| `name` | string | no | display name when saving to an account |
| `size` | int 64–1024 | no | default 256 |
| `darkColor` | `#RRGGBB` | no | default `#000000` |
| `lightColor` | `#RRGGBB` | no | default `#FFFFFF` |
| `dotStyle` | `square` \| `dots` \| `rounded` \| `extra-rounded` \| `classy` \| `classy-rounded` | no | module shape |
| `cornerStyle` | `square` \| `dot` \| `extra-rounded` | no | the three corner squares |
| `frameStyle` | `square` \| `rounded` \| `circle` \| `dashed` | no | `square` means no frame |
| `caption` | string ≤60 | no | text under the code; implies a frame |
| `format` | `png` \| `svg` \| `pdf` | no | default `png`; **svg/pdf need a key** |

Returns a hosted image URL plus a base64 data URL for inline display. `svg` and `pdf` come back as
a data URL in the text response rather than an image block, since a PDF is not one and many clients
will not draw an SVG one.

**Every design option is free, on every plan and with no key at all** — colour, size, dot and corner
styling, frames and captions, with no watermark on any output. What the paid plans sell is dynamic
codes, analytics, stored-code volume and the managed API. Logo embedding is free too but is not a
parameter here: it needs a base64 data URL, which is a poor fit for a tool call.

`format: "svg" | "pdf"` is the one asymmetry, and it is a cost control rather than a paywall: vector
and PDF are the most expensive render path, so they are metered per key instead of per IP. Both are
free in the dashboard and in the no-signup generator on theqrcode.io, on every plan.

**Anonymous** → the public keyless API, 100 requests/hour per IP. The hosted link is a **24-hour
preview**; download the image rather than bookmarking the URL. The QR code itself never expires —
it is the preview *hosting* that is temporary.

**Authenticated** → the v1 API. The code is **saved to your account permanently**, rate limited by
key rather than IP, and `format: "svg" | "pdf"` becomes available.

### `list_qr_codes` — Developer plan

Lists codes saved to your account. `page`, `limit` (1–100), `type` filter.

### `get_analytics` — Developer plan

Scan analytics, account-wide or for one `qrCodeId`. `timeRange`: `1h`, `1d`, `7d`, `30d`
(default), `90d`, `1y`.

Returns total and unique scans, time, approximate location (country/city derived from IP — regional,
not GPS), device and OS, and campaign. Static QR codes cannot be tracked; analytics require a dynamic
code.

---

## Plans

| | Anonymous | Developer ($19/mo) | Pro ($29/mo) |
|---|---|---|---|
| `generate_qr_code` | ✅ all 5 types, full design | ✅ + svg/pdf output | ✅ + svg/pdf output |
| Codes saved to account | ❌ 24h preview link | ✅ permanent | ✅ permanent |
| `list_qr_codes` | ❌ | ✅ | ❌ |
| `get_analytics` | ❌ | ✅ | ❌ |
| MCP rate limit | 100/hr per IP | 2,000/hr per key | 500/hr per key |

MCP calls also count toward the key's 5,000/hr REST API limit; the MCP limit is a cap within it.

API keys: <https://theqrcode.io/pricing>

---

## Running it yourself

The hosted server at `mcp.theqrcode.io` is the supported path — you do not need to run this. But it
is a plain Express app if you want to:

```bash
npm install
npm run build
npm start          # or: npm run dev
npm test
```

| Env | Default | Purpose |
|---|---|---|
| `QR_API_BASE` | `https://theqrcode.io` | REST API this server wraps |
| `PORT` | `3001` | listen port |

Routes: `POST|GET|DELETE /mcp` (stateless — a fresh server and transport per request), `GET /health`.

Docker:

```bash
docker build -t theqrcode-mcp .
docker run -p 3001:3000 -e PORT=3000 theqrcode-mcp
```

---

## What it wraps

TheQRCode.io is a QR code generation and analytics platform: static and dynamic QR codes for URLs,
WiFi, vCard contacts, text and email, with scan analytics by time, device and approximate location.
Static codes never expire, printed codes are never switched off to force an upgrade, and the design
of a code is never billed for.

This server is one of three ways in — the others are a
[keyless REST API](https://theqrcode.io/qr-code-api) and
[OpenAI function calling](https://theqrcode.io/ai-agents).

- Site — <https://theqrcode.io>
- REST API — <https://theqrcode.io/qr-code-api>
- OpenAPI spec — <https://theqrcode.io/api/public/qr-codes/openapi.json>
- Agent guide — <https://theqrcode.io/llms-full.txt>

## License

MIT — see [LICENSE](LICENSE).
