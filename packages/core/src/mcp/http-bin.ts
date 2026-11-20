import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLlmWikiHttpServer } from './http.js';

async function main(): Promise<void> {
  const wikiRoot = resolve(process.argv[2] ?? process.env.LLMWIKI_ROOT ?? '.wiki');
  const host = process.env.LLMWIKI_HTTP_HOST ?? '127.0.0.1';
  const port = Number.parseInt(process.env.LLMWIKI_HTTP_PORT ?? '3000', 10);

  try {
    const info = await stat(wikiRoot);
    if (!info.isDirectory()) {
      throw new Error(`${wikiRoot} exists but is not a directory`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `llmwiki-mcp-http: wiki root not found at ${wikiRoot}. ${message}\n`,
    );
    process.exit(1);
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid HTTP port: ${port}`);
  }

  const httpServer = createLlmWikiHttpServer({ host, port, wikiRoot });

  httpServer.listen(port, host, () => {
    console.log(`LLM Wiki MCP HTTP server listening on http://${host}:${port}/mcp`);
    console.log(`Health check: http://${host}:${port}/health`);
  });

  const shutdown = async (): Promise<void> => {
    httpServer.close();
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`llmwiki-mcp-http: fatal error — ${message}\n`);
  process.exit(1);
});
