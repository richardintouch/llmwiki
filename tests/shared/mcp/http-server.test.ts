import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLlmWikiHttpServer } from '../../../packages/core/src/mcp/http.js';
import { initWiki } from '../../../packages/core/src/init.js';

let cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  cleanupDirectories = [];
});

describe('LLM Wiki Streamable HTTP MCP server', () => {
  it('exposes wiki_list_pages over HTTP', async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), 'llmwiki-http-'));
    cleanupDirectories.push(projectDirectory);
    await initWiki(projectDirectory);

    const wikiRoot = join(projectDirectory, '.wiki');
    const httpServer = createLlmWikiHttpServer({ wikiRoot, host: '127.0.0.1', port: 0 });

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });

    const address = httpServer.address() as AddressInfo;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );
    const client = new Client({ name: 'llmwiki-http-test', version: '1.0.0' });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('wiki_list_pages');

      const result = await client.callTool({
        name: 'wiki_list_pages',
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
