import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { z } from "zod";

const API_BASE = process.env.QR_API_BASE ?? "https://theqrcode.io";
const PORT = process.env.PORT ?? 3001;

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

const GenerateQRInput = {
  type: z
    .enum(["url", "wifi", "contact", "text"])
    .describe(
      "QR code type. Use 'url' for web links, 'wifi' for network credentials " +
        "(format: WIFI:T:WPA;S:<ssid>;P:<password>;;), 'contact' for vCard data, " +
        "'text' for arbitrary strings."
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

// ---------------------------------------------------------------------------
// Factory: creates a fresh McpServer with all tools registered.
// Called once per HTTP request so stateless transport works correctly.
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer({
    name: "theqrcode-mcp",
    version: "1.0.0",
  });

  server.tool(
    "generate_qr_code",
    "Generate a QR code image. Use this whenever a user asks to create, make, or generate a QR " +
      "code for a URL, website, WiFi network, contact card, or text. Returns a hosted image URL " +
      "(shareable, valid 24 hours) and a base64 PNG data URL for inline display.",
    GenerateQRInput,
    async ({ type, content, size, darkColor, lightColor }) => {
      // Build request body
      const body: Record<string, unknown> = { type, content };

      const settings: Record<string, unknown> = {};
      if (size !== undefined) settings.size = size;
      if (darkColor !== undefined || lightColor !== undefined) {
        const color: Record<string, string> = {};
        if (darkColor) color.dark = darkColor;
        if (lightColor) color.light = lightColor;
        settings.color = color;
      }
      if (Object.keys(settings).length > 0) body.settings = settings;

      let res: globalThis.Response;
      try {
        res = await fetch(`${API_BASE}/api/public/qr-codes`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "theqrcode-mcp/1.0",
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw new Error(`Failed to reach QR API: ${String(err)}`);
      }

      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After") ?? "60";
        throw new Error(
          `Rate limit reached. The QR code API allows 100 requests per hour per IP. ` +
            `Please retry after ${retryAfter} seconds.`
        );
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(
          `QR API returned ${res.status}: ${String(body["message"] ?? res.statusText)}`
        );
      }

      const data = (await res.json()) as {
        qrImage: string;
        imageUrl: string;
        type: string;
        content: string;
      };

      // Strip the data URL prefix so we can return a clean base64 blob
      const base64 = data.qrImage.replace(/^data:image\/[^;]+;base64,/, "");

      return {
        content: [
          {
            type: "text" as const,
            text:
              `QR code generated.\n` +
              `Type: ${data.type}\n` +
              `Content: ${data.content}\n` +
              `Hosted URL: ${data.imageUrl}\n` +
              `\n` +
              `The image URL can be shared directly or embedded in a page. It expires in 24 hours.`,
          },
          {
            type: "image" as const,
            data: base64,
            mimeType: "image/png" as const,
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
  res.json({ status: "ok", service: "theqrcode-mcp", version: "1.0.0" });
});

// MCP endpoint — stateless: new server + transport per request
async function handleMcp(req: Request, res: Response): Promise<void> {
  const server = createServer();
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

app.post("/mcp", handleMcp);
app.get("/mcp", handleMcp);
app.delete("/mcp", handleMcp);

app.listen(PORT, () => {
  console.log(`theqrcode MCP server listening on port ${PORT}`);
  console.log(`  Health:   http://localhost:${PORT}/health`);
  console.log(`  MCP:      http://localhost:${PORT}/mcp`);
  console.log(`  API base: ${API_BASE}`);
});
