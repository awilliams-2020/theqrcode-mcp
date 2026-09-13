import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { z } from "zod";

const API_BASE = process.env.QR_API_BASE ?? "https://theqrcode.io";
const PORT     = process.env.PORT ?? 3001;

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

/**
 * Extract an API key from the request Authorization header.
 * Accepts:  Authorization: Bearer qr_...  (the format ApiKeyManager issues)
 * Returns null when no key is present (public / unauthenticated session).
 */
function extractApiKey(req: Request): string | null {
  const auth = (req.headers["authorization"] as string | undefined) ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  return null;
}

// ---------------------------------------------------------------------------
// Client IP forwarding
// ---------------------------------------------------------------------------

/**
 * The end user's address, or null when this request did not arrive through Traefik.
 *
 * This server is published at `mcp.theqrcode.io`, so Traefik terminates every real
 * session and writes `x-real-ip` / `x-forwarded-for` from the TCP peer after deleting
 * the client's own copies. Those two headers are therefore trustworthy here, and they
 * are the ONLY ones that are — same trust boundary as the app's `src/lib/request-ip.ts`,
 * which this deliberately mirrors. Keep the two in step.
 *
 * `x-forwarded-for` is a list where every hop appends, so the rightmost entry is the
 * one written by the proxy nearest us; reading `[0]` would read whatever the client
 * chose to prepend.
 */
function extractClientIP(req: Request): string | null {
  const realIP = (req.headers["x-real-ip"] as string | undefined)?.trim();
  if (realIP) return realIP;

  const forwarded = req.headers["x-forwarded-for"] as string | undefined;
  if (forwarded) {
    const hops = forwarded.split(",");
    return hops[hops.length - 1]!.trim() || null;
  }

  return null;
}

/**
 * Headers for a call out to the QR API.
 *
 * `X-Forwarded-For` is what makes the end user visible downstream. Without it the
 * API sees only this container: the outbound fetch carries no forwarded header, so
 * Next.js synthesises one from the peer socket and every MCP user in the world
 * arrives as `172.24.0.3` on `theqrcode_internal`. That collapses them into a single
 * rate-limit fingerprint (`rl:pub:sliding:172.24.0.3:<ua hash>`) sharing one 100/hr
 * budget, puts them one shared `rl:pub:blocked:172.24.0.3` away from a 24h outage of
 * the whole anonymous MCP surface, and lands every server-side Matomo event with a
 * docker IP and no geography.
 *
 * Omitted when `clientIp` is null — a caller that did not come through Traefik has no
 * address worth asserting, and forwarding a guess would be worse than forwarding
 * nothing.
 */
function apiHeaders(
  clientIp: string | null,
  extra?: Record<string, string>
): Record<string, string> {
  return {
    "User-Agent": "theqrcode-mcp/1.2",
    ...(clientIp ? { "X-Forwarded-For": clientIp } : {}),
    ...extra,
  };
}

/**
 * Sent on every authenticated upstream call, naming the tool. It tells theqrcode.io the
 * call is MCP rather than plain REST, which applies the plan's MCP hourly limit
 * (Developer 2,000, Pro 500) and keeps list_qr_codes / get_analytics Developer-only —
 * while the same REST routes stay open to Pro keys called directly.
 */
const MCP_TOOL_HEADER = "X-MCP-Tool";

/** The API's own reason for a 429 (MCP or API limit), or a generic message. */
async function rateLimitMessage(res: globalThis.Response, retryAfter: string): Promise<string> {
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  return typeof data["error"] === "string"
    ? data["error"]
    : `Rate limit reached for your API key. Please retry after ${retryAfter} seconds.`;
}

/** The API's own reason for a 403 (plan, permission, sandbox), or a fallback. */
async function forbiddenMessage(res: globalThis.Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  return typeof data["error"] === "string" ? data["error"] : fallback;
}

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

const GenerateQRInput = {
  type: z
    .enum(["url", "wifi", "contact", "text", "email"])
    .describe(
      "QR code type. Use 'url' for web links, 'wifi' for network credentials " +
        "(format: WIFI:T:WPA;S:<ssid>;P:<password>;;), 'contact' for vCard data, " +
        "'text' for arbitrary strings, 'email' for email addresses. " +
        "Note: 'email' requires a Bearer token — it cannot be used with the public (unauthenticated) MCP session."
    ),
  name: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Display name when saving via the authenticated API. If omitted, a name is derived from " +
        "type and content."
    ),
  content: z
    .string()
    .min(1)
    .describe(
      "The data to encode. Examples: 'https://example.com' for url, " +
        "'WIFI:T:WPA;S:MyNetwork;P:secret;;' for wifi, plain text for text type."
    ),
  size: z
    .number()
    .int()
    .min(64)
    .max(1024)
    .optional()
    .describe("Output image size in pixels (64–1024). Defaults to 256."),
  darkColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional()
    .describe("Hex color for dark QR modules, e.g. '#1a1a1a'. Defaults to '#000000'."),
  lightColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional()
    .describe("Hex color for the background, e.g. '#ffffff'. Defaults to '#FFFFFF'."),
};

const ListQRCodesInput = {
  page: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Page number for pagination. Defaults to 1."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of QR codes per page (1–100). Defaults to 20."),
  type: z
    .enum(["url", "wifi", "contact", "text", "email"])
    .optional()
    .describe("Filter by QR code type."),
};

const GetAnalyticsInput = {
  qrCodeId: z
    .string()
    .optional()
    .describe("Filter analytics to a specific QR code ID. Omit for account-wide totals."),
  timeRange: z
    .enum(["1h", "1d", "7d", "30d", "90d", "1y"])
    .optional()
    .describe("Time range for analytics data. Defaults to '30d'."),
};

/** POST /api/v1/qr-codes requires `name`; used when the tool omits it. */
function defaultQrNameForMcp(type: string, content: string): string {
  const max     = 100;
  const oneLine = content.replace(/\s+/g, " ").trim();
  const snippet = oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
  return `MCP ${type}: ${snippet}`;
}

/**
 * Public POST returns `imageUrl`; v1 POST may omit it and only set `shortUrl` (dynamic QRs).
 */
function formatShareLinkLine(
  data: { imageUrl?: string; shortUrl?: string | null },
  isAuthenticated: boolean
): string {
  if (data.imageUrl) return `Hosted URL: ${data.imageUrl}`;
  if (data.shortUrl) return `Short URL (tracking): ${data.shortUrl}`;
  if (isAuthenticated) {
    return (
      "Hosted URL: not returned by the API for this QR code; use the PNG above or your dashboard."
    );
  }
  return "Hosted URL: not provided.";
}

/** GET /api/v1/qr-codes returns totals under `pagination`; tolerate a flat legacy shape. */
function normalizeListPagination(raw: {
  data:    unknown[];
  pagination?: { page: number; limit: number; total: number };
  page?:   number;
  limit?:  number;
  total?:  number;
}): { page: number; limit: number; total: number } {
  const p     = raw.pagination;
  const page  = p?.page ?? raw.page ?? 1;
  const limit = p?.limit ?? raw.limit ?? 20;
  const total = p?.total ?? raw.total ?? raw.data.length;
  return { page, limit, total };
}

// ---------------------------------------------------------------------------
// Factory: creates a fresh McpServer with all tools registered.
// Called once per HTTP request so stateless transport works correctly.
// ---------------------------------------------------------------------------

function createServer(apiKey: string | null, clientIp: string | null): McpServer {
  const server          = new McpServer({ name: "theqrcode-mcp", version: "1.2.0" });
  const isAuthenticated = apiKey !== null;

  // -------------------------------------------------------------------------
  // Tool: generate_qr_code
  // Unauthenticated → public endpoint (ephemeral 24h URL, IP rate limited)
  // Authenticated   → v1 endpoint  (saved to account, key rate limited)
  // -------------------------------------------------------------------------

  server.tool(
    "generate_qr_code",
    "Generate a QR code image. Use this whenever a user asks to create, make, or generate a QR " +
      "code for a URL, website, WiFi network, contact card, email, or text. " +
      "Returns a hosted image URL and a base64 PNG data URL for inline display. " +
      "When authenticated, the QR code is saved to the user's account.",
    GenerateQRInput,
    async ({ type, content, name, size, darkColor, lightColor }) => {
      if (!isAuthenticated && type === "email") {
        throw new Error(
          'type "email" requires an API key. The public QR API only supports url, wifi, contact, ' +
            "and text — use one of those, or connect with a Bearer token."
        );
      }

      const body: Record<string, unknown> = { type, content };
      const settings: Record<string, unknown> = {};

      if (isAuthenticated) {
        const trimmed = name?.trim();
        body.name =
          trimmed && trimmed.length > 0 ? trimmed : defaultQrNameForMcp(type, content);
      }

      if (size !== undefined) settings.size = size;
      if (darkColor !== undefined || lightColor !== undefined) {
        const color: Record<string, string> = {};
        if (darkColor)  color.dark  = darkColor;
        if (lightColor) color.light = lightColor;
        settings.color = color;
      }
      if (Object.keys(settings).length > 0) body.settings = settings;

      // Route to authenticated v1 endpoint when a key is present
      const endpoint = isAuthenticated
        ? `${API_BASE}/api/v1/qr-codes`
        : `${API_BASE}/api/public/qr-codes`;

      const headers = apiHeaders(clientIp, { "Content-Type": "application/json" });
      if (isAuthenticated) {
        headers["Authorization"] = `Bearer ${apiKey}`;
        headers[MCP_TOOL_HEADER] = "generate_qr_code";
      }

      let res: globalThis.Response;
      try {
        res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
      } catch (err) {
        throw new Error(`Failed to reach QR API: ${String(err)}`);
      }

      if (res.status === 401) {
        throw new Error(
          "Invalid API key. Check your Authorization header in the MCP configuration."
        );
      }

      if (res.status === 403) {
        const data = await res.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(
          `Access denied: ${String(data["error"] ?? "your plan does not support this QR type or operation")}`
        );
      }

      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After") ?? "60";
        if (isAuthenticated) {
          // The API says which limit fired (the plan's MCP limit or the key's API limit).
          throw new Error(await rateLimitMessage(res, retryAfter));
        }
        throw new Error(
          `Rate limit reached for the public API (100 req/hr per IP). Please retry after ${retryAfter} seconds.`
        );
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(`QR API returned ${res.status}: ${String(data["error"] ?? res.statusText)}`);
      }

      const data = (await res.json()) as {
        qrImage:   string;
        imageUrl?: string;
        shortUrl?: string | null;
        type:      string;
        content:   string;
        id?:       string;
      };

      const base64 = data.qrImage.replace(/^data:image\/[^;]+;base64,/, "");
      const savedNote = isAuthenticated && data.id
        ? `\nSaved to account with ID: ${data.id}`
        : "\nNote: QR code is ephemeral — the hosted URL expires in 24 hours.";

      return {
        content: [
          {
            type: "text" as const,
            text:
              `QR code generated.\n` +
              `Type: ${data.type}\n` +
              `Content: ${data.content}\n` +
              `${formatShareLinkLine(data, isAuthenticated)}` +
              savedNote,
          },
          {
            type:     "image" as const,
            data:     base64,
            mimeType: "image/png" as const,
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Extended tools — Developer plan only.
  //
  // These are ADVERTISED to every session, authenticated or not, so that
  // directory crawlers (Glama, MCP registries) that probe tools/list
  // anonymously can see the full surface. Each one refuses at call time
  // without a key; the descriptions state the plan requirement up front, so
  // the listing never implies analytics is free.
  // -------------------------------------------------------------------------

  // Tool: list_qr_codes
  server.tool(
    "list_qr_codes",
    "List QR codes saved to the authenticated user's account. " +
      "Supports pagination and filtering by type. " +
      "Requires an authenticated API key (Developer plan).",
    ListQRCodesInput,
    async ({ page = 1, limit = 20, type }) => {
      if (!isAuthenticated) {
        throw new Error(
          "list_qr_codes requires a Developer plan API key. Reconnect with an " +
            "Authorization: Bearer <api key> header — keys at https://theqrcode.io/pricing."
        );
      }

      const params = new URLSearchParams({
        page:  String(page),
        limit: String(limit),
      });
      if (type) params.set("type", type);

      let res: globalThis.Response;
      try {
        res = await fetch(`${API_BASE}/api/v1/qr-codes?${params}`, {
          headers: apiHeaders(clientIp, { Authorization: `Bearer ${apiKey}`, [MCP_TOOL_HEADER]: "list_qr_codes" }),
        });
      } catch (err) {
        throw new Error(`Failed to reach QR API: ${String(err)}`);
      }

      if (res.status === 403) {
        throw new Error(await forbiddenMessage(res, "list_qr_codes requires a Developer plan API key."));
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(`QR API returned ${res.status}: ${String(data["error"] ?? res.statusText)}`);
      }

      const raw = (await res.json()) as {
        data:        unknown[];
        pagination?: { page: number; limit: number; total: number };
        total?:      number;
        page?:       number;
        limit?:      number;
      };
      const { page: listPage, total: listTotal } = normalizeListPagination(raw);

      type QrRow = { id: string; name: string; type: string; isDynamic?: boolean }
      const summary = (raw.data as QrRow[])
        .slice(0, 20)
        .map((qr) => `• [${qr.id}] ${qr.name} (${qr.type})${qr.isDynamic ? " [dynamic]" : ""}`)
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text:
              `QR codes (page ${listPage}, showing ${raw.data.length} of ${listTotal}):\n\n` +
              (summary || "No QR codes found."),
          },
        ],
      };
    }
  );

  // Tool: get_analytics
  server.tool(
    "get_analytics",
    "Get scan analytics for the authenticated user's QR codes. " +
      "Optionally filter to a specific QR code by ID. " +
      "Requires an authenticated API key (Developer plan).",
    GetAnalyticsInput,
    async ({ qrCodeId, timeRange = "30d" }) => {
      if (!isAuthenticated) {
        throw new Error(
          "get_analytics requires a Developer plan API key. Reconnect with an " +
            "Authorization: Bearer <api key> header — keys at https://theqrcode.io/pricing."
        );
      }

      const params = new URLSearchParams({ timeRange });
      if (qrCodeId) params.set("qrCodeId", qrCodeId);

      let res: globalThis.Response;
      try {
        res = await fetch(`${API_BASE}/api/v1/analytics?${params}`, {
          headers: apiHeaders(clientIp, { Authorization: `Bearer ${apiKey}`, [MCP_TOOL_HEADER]: "get_analytics" }),
        });
      } catch (err) {
        throw new Error(`Failed to reach QR API: ${String(err)}`);
      }

      if (res.status === 403) {
        throw new Error(await forbiddenMessage(res, "get_analytics requires a Developer plan API key."));
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(`QR API returned ${res.status}: ${String(data["error"] ?? res.statusText)}`);
      }

      const data = await res.json() as Record<string, unknown>;

      return {
        content: [
          {
            type: "text" as const,
            text: `Analytics (${timeRange}):\n\n${JSON.stringify(data, null, 2)}`,
          },
        ],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "theqrcode-mcp", version: "1.2.0" });
});

// Glama.ai ownership verification — HTTP challenge for mcp.theqrcode.io
app.get("/.well-known/glama.json", (_req, res) => {
  res.json({
    $schema: "https://glama.ai/mcp/schemas/connector.json",
    claim: "glama_claim_BiVRVGdfn0MbZmHGkoQMyLDWQsWIXfKI",
  });
});

// MCP endpoint — stateless: new server + transport per request
async function handleMcp(req: Request, res: Response): Promise<void> {
  const apiKey   = extractApiKey(req);
  const clientIp = extractClientIP(req);
  const server   = createServer(apiKey, clientIp);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });

  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

app.post("/mcp",   handleMcp);
app.get("/mcp",    handleMcp);
app.delete("/mcp", handleMcp);

app.listen(PORT, () => {
  console.log(`theqrcode MCP server listening on port ${PORT}`);
  console.log(`  Health:   http://localhost:${PORT}/health`);
  console.log(`  MCP:      http://localhost:${PORT}/mcp`);
  console.log(`  API base: ${API_BASE}`);
  console.log(`  Auth:     Bearer token via Authorization header`);
});
