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
 * Accepts:  Authorization: Bearer tqc_sk_...
 * Returns null when no key is present (public / unauthenticated session).
 */
function extractApiKey(req: Request): string | null {
  const auth = (req.headers["authorization"] as string | undefined) ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  return null;
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
        "Note: 'email' type requires an authenticated API key (Developer or Pro plan)."
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

// ---------------------------------------------------------------------------
// Factory: creates a fresh McpServer with all tools registered.
// Called once per HTTP request so stateless transport works correctly.
// ---------------------------------------------------------------------------

function createServer(apiKey: string | null): McpServer {
  const server          = new McpServer({ name: "theqrcode-mcp", version: "1.1.0" });
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
    async ({ type, content, size, darkColor, lightColor }) => {
      const body: Record<string, unknown> = { type, content };
      const settings: Record<string, unknown> = {};

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

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent":   "theqrcode-mcp/1.1",
      };
      if (isAuthenticated) headers["Authorization"] = `Bearer ${apiKey}`;

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
        const limitType  = isAuthenticated ? "your API key" : "the public API (100 req/hr per IP)";
        throw new Error(
          `Rate limit reached for ${limitType}. Please retry after ${retryAfter} seconds.`
        );
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(`QR API returned ${res.status}: ${String(data["error"] ?? res.statusText)}`);
      }

      const data = (await res.json()) as {
        qrImage:  string;
        imageUrl: string;
        type:     string;
        content:  string;
        id?:      string;
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
              `Hosted URL: ${data.imageUrl}` +
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
  // Extended tools — Developer plan only (authenticated sessions)
  // -------------------------------------------------------------------------

  if (isAuthenticated) {
    // Tool: list_qr_codes
    server.tool(
      "list_qr_codes",
      "List QR codes saved to the authenticated user's account. " +
        "Supports pagination and filtering by type. " +
        "Requires an authenticated API key (Developer plan).",
      ListQRCodesInput,
      async ({ page = 1, limit = 20, type }) => {
        const params = new URLSearchParams({
          page:  String(page),
          limit: String(limit),
        });
        if (type) params.set("type", type);

        let res: globalThis.Response;
        try {
          res = await fetch(`${API_BASE}/api/v1/qr-codes?${params}`, {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "User-Agent":  "theqrcode-mcp/1.1",
            },
          });
        } catch (err) {
          throw new Error(`Failed to reach QR API: ${String(err)}`);
        }

        if (res.status === 403) {
          throw new Error(
            "list_qr_codes requires a Developer plan API key."
          );
        }

        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as Record<string, unknown>;
          throw new Error(`QR API returned ${res.status}: ${String(data["error"] ?? res.statusText)}`);
        }

        const data = await res.json() as {
          data:  unknown[];
          total: number;
          page:  number;
          limit: number;
        };

        const summary = data.data
          .slice(0, 20)
          .map((qr: any) => `• [${qr.id}] ${qr.name} (${qr.type})${qr.isDynamic ? " [dynamic]" : ""}`)
          .join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text:
                `QR codes (page ${data.page}, showing ${data.data.length} of ${data.total}):\n\n` +
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
        const params = new URLSearchParams({ timeRange });
        if (qrCodeId) params.set("qrCodeId", qrCodeId);

        let res: globalThis.Response;
        try {
          res = await fetch(`${API_BASE}/api/v1/analytics?${params}`, {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "User-Agent":  "theqrcode-mcp/1.1",
            },
          });
        } catch (err) {
          throw new Error(`Failed to reach QR API: ${String(err)}`);
        }

        if (res.status === 403) {
          throw new Error(
            "get_analytics requires a Developer plan API key."
          );
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
  }

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "theqrcode-mcp", version: "1.1.0" });
});

// MCP endpoint — stateless: new server + transport per request
async function handleMcp(req: Request, res: Response): Promise<void> {
  const apiKey = extractApiKey(req);
  const server = createServer(apiKey);
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
