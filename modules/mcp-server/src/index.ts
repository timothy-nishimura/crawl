/**
 * @crawl/mcp-server — entry point
 *
 * Exposes the crawl engine as two MCP tools over HTTP:
 *
 *   POST /mcp      — MCP endpoint (Streamable HTTP transport, stateless)
 *   GET  /health   — Health check
 *
 * Claude configuration (claude_desktop_config.json):
 *
 *   {
 *     "mcpServers": {
 *       "crawler": {
 *         "url": "http://localhost:3001/mcp"
 *       }
 *     }
 *   }
 *
 * Environment variables:
 *   PORT  — listening port (default: 3001)
 */

import { resolve, dirname }               from 'node:path';
import { fileURLToPath }                  from 'node:url';
import express                           from 'express';
import { McpServer }                     from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport }          from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerCrawlTool }             from './tools/crawl.js';
import { registerFetchPageTool }         from './tools/fetchPage.js';
import { registerFetchApiTool }          from './tools/fetchApi.js';
import { registerParseSitemapTool }      from './tools/parseSitemap.js';
import { registerSearchManifestTool }    from './tools/searchManifest.js';
import { registerSummarizeManifestTool } from './tools/summarizeManifest.js';
import { registerAnalyzeLinks }          from './tools/analyzeLinks.js';
import { registerAnalyzeMeta }           from './tools/analyzeMeta.js';
import { registerAnalyzeHeadings }       from './tools/analyzeHeadings.js';
import { registerAnalyzeImages }         from './tools/analyzeImages.js';
import { registerAnalyzeSchema }         from './tools/analyzeSchema.js';
import { registerCompareManifests }      from './tools/compareManifests.js';
import { registerFindOrphans }           from './tools/findOrphans.js';


const PORT    = parseInt(process.env['PORT'] ?? '3001', 10);
const VERSION = '1.0.0';

// ── Scratch Directory ─────────────────────────────────────────────────────────
// Ensure we don't default to C:\Windows\System32\scratch on Windows.
// Derive the project root from this file's location.
// dist/index.js is at {root}/modules/mcp-server/dist/index.js → 3 levels up.
// This is the only reliable approach when spawned by Claude Desktop from
// C:\WINDOWS\System32 (where process.cwd() is not the project root).
{
  const __filename = fileURLToPath(import.meta.url);
  const __dirname  = dirname(__filename);
  const projectRoot = resolve(__dirname, '..', '..', '..');

  if (!process.env['CRAWL_ROOT']) {
    process.env['CRAWL_ROOT'] = projectRoot;
  }
  if (!process.env['SCRATCH_DIR']) {
    process.env['SCRATCH_DIR'] = resolve(projectRoot, 'scratch');
  }
}

// ── MCP server & transport ───────────────────────────────────────────────────
//
// We use a singleton server and transport instance to support persistent
// sessions (SSE). Each client connection is assigned a unique session ID.

const sessions = new Map<string, { server: McpServer, transport: StreamableHTTPServerTransport }>();

function createSession() {
  const server = new McpServer({
    name:    'crawl-engine',
    version: VERSION,
  });

  registerCrawlTool(server);
  registerFetchPageTool(server);
  registerFetchApiTool(server);
  registerParseSitemapTool(server);
  registerSearchManifestTool(server);
  registerSummarizeManifestTool(server);
  registerAnalyzeLinks(server);
  registerAnalyzeMeta(server);
  registerAnalyzeHeadings(server);
  registerAnalyzeImages(server);
  registerAnalyzeSchema(server);
  registerCompareManifests(server);
  registerFindOrphans(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  return { server, transport };
}

// ── Express app ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:  'ok',
    server:  'crawl-engine',
    version: VERSION,
    activeSessions: sessions.size,
    sessionIds: Array.from(sessions.keys()),
    tools: [
      'crawl', 'fetch_page', 'fetch_api', 'parse_sitemap', 'search_manifest', 'summarize_manifest',
      'analyze_links', 'analyze_meta', 'analyze_headings', 'analyze_images',
      'analyze_schema', 'compare_manifests', 'find_orphans',
    ],

  });
});

// ── MCP endpoint ───────────────────────────────────────────────────────────────
//
// Handles both GET (to establish SSE stream) and POST (to send messages).
// We manage multiple sessions by creating a dedicated server/transport for each client.

app.all('/mcp', async (req, res) => {
  try {
    let sessionId = req.headers['mcp-session-id'] as string || req.query['sessionId'] as string;
    let session = sessionId ? sessions.get(sessionId) : null;

    // For initialization (POST with 'initialize' method), we create a new session if one wasn't provided
    const isInitialize = req.method === 'POST' && req.body?.method === 'initialize';

    if (isInitialize && !session) {
      session = createSession();
      // We need to connect the server to the transport before handling the first request
      await session.server.connect(session.transport);
      
      // The transport will generate a session ID during the first handleRequest call.
      // We'll capture it after the call and store the session.
    }

    if (!session && !isInitialize) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found or expired' },
        id: null
      });
      return;
    }

    // Use a temporary transport if we're creating a new one to handle the initialization
    const activeTransport = session!.transport;

    await activeTransport.handleRequest(req, res, req.body);

    // If this was an initialization, capture the newly generated session ID
    if (isInitialize && session) {
      const newSessionId = activeTransport.sessionId;
      if (newSessionId) {
        sessions.set(newSessionId, session);
        console.error(`[mcp] created new session: ${newSessionId}`);
      }
    }
  } catch (err) {
    console.error('[mcp] unhandled error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null
      });
    }
  }
});

// ── Execution Mode ──────────────────────────────────────────────────────────
//
// If run with a PORT environment variable (or in Docker), we start the HTTP 
// server for SSE sessions. Otherwise, we default to Stdio for Claude Desktop.

if (process.env['PORT'] || process.env['KUBERNETES_SERVICE_HOST']) {
  app.listen(PORT, '0.0.0.0', () => {
    console.error(`crawl-engine MCP server v${VERSION} (HTTP mode)`);
    console.error(`  MCP endpoint : http://0.0.0.0:${PORT}/mcp`);
    console.error(`  Health check : http://0.0.0.0:${PORT}/health`);
  });
} else {
  // Stdio mode for Claude Desktop
  const { server } = createSession();
  const transport = new StdioServerTransport();
  server.connect(transport).catch(err => {
    console.error('[stdio] Failed to connect transport:', err);
    process.exit(1);
  });
}
