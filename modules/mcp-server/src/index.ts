import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerCrawlTool } from './tools/crawl.js';
import { registerFetchPageTool } from './tools/fetchPage.js';
import { registerFetchApiTool } from './tools/fetchApi.js';
import { registerParseSitemapTool } from './tools/parseSitemap.js';
import { registerSearchManifestTool } from './tools/searchManifest.js';
import { registerSummarizeManifestTool } from './tools/summarizeManifest.js';
import { registerAnalyzeLinks } from './tools/analyzeLinks.js';
import { registerAnalyzeMeta } from './tools/analyzeMeta.js';
import { registerAnalyzeHeadings } from './tools/analyzeHeadings.js';
import { registerAnalyzeImages } from './tools/analyzeImages.js';
import { registerAnalyzeSchema } from './tools/analyzeSchema.js';
import { registerCompareManifests } from './tools/compareManifests.js';
import { registerFindOrphans } from './tools/findOrphans.js';

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);
const VERSION = '1.0.0';
const API_KEY = process.env['MCP_API_KEY'];
const MAX_SESSIONS = 100;
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

{
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const projectRoot = resolve(__dirname, '..', '..', '..');

  if (!process.env['CRAWL_ROOT']) {
    process.env['CRAWL_ROOT'] = projectRoot;
  }
  if (!process.env['SCRATCH_DIR']) {
    process.env['SCRATCH_DIR'] = resolve(projectRoot, 'scratch');
  }
  if (!process.env['MANIFESTS_DIR']) {
    process.env['MANIFESTS_DIR'] = resolve(projectRoot, 'manifests');
  }
  if (!process.env['DATA_DIR']) {
    process.env['DATA_DIR'] = resolve(projectRoot, 'data');
  }
}

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActive: number;
}

const sessions = new Map<string, SessionEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActive > SESSION_IDLE_TIMEOUT_MS) {
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

function createSession() {
  const server = new McpServer({
    name: 'crawl-engine',
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

  return { server, transport, lastActive: Date.now() };
}

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'crawl-engine',
    version: VERSION,
    activeSessions: sessions.size,
    tools: [
      'crawl', 'fetch_page', 'fetch_api', 'parse_sitemap', 'search_manifest', 'summarize_manifest',
      'analyze_links', 'analyze_meta', 'analyze_headings', 'analyze_images',
      'analyze_schema', 'compare_manifests', 'find_orphans',
    ],
  });
});

app.all('/mcp', async (req, res) => {
  if (API_KEY) {
    const auth = req.headers['authorization'];
    if (!auth || auth !== `Bearer ${API_KEY}`) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unauthorized' },
        id: null,
      });
      return;
    }
  }

  try {
    const sessionId = (req.headers['mcp-session-id'] as string) || (req.query['sessionId'] as string);
    let session = sessionId ? sessions.get(sessionId) : null;

    const isInitialize = req.method === 'POST' && req.body?.method === 'initialize';

    if (isInitialize && !session) {
      if (sessions.size >= MAX_SESSIONS) {
        res.status(503).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Session limit reached' },
          id: null,
        });
        return;
      }

      session = createSession();
      await session.server.connect(session.transport);
    }

    if (!session && !isInitialize) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found or expired' },
        id: null,
      });
      return;
    }

    session!.lastActive = Date.now();
    const activeTransport = session!.transport;

    await activeTransport.handleRequest(req, res, req.body);

    if (isInitialize && session) {
      const newSessionId = activeTransport.sessionId;
      if (newSessionId) {
        sessions.set(newSessionId, session);
      }
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

if (process.env['PORT'] || process.env['KUBERNETES_SERVICE_HOST']) {
  app.listen(PORT, '0.0.0.0', () => {
    console.error(`crawl-engine MCP server v${VERSION} running on port ${PORT}`);
  });
} else {
  const { server } = createSession();
  const transport = new StdioServerTransport();
  server.connect(transport).catch(err => {
    console.error('[stdio] Transport error:', err);
    process.exit(1);
  });
}
