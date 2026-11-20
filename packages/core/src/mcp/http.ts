import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createMcpServer } from './server.js';

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  openResponses: number;
  lastActive: number;
}

export interface LlmWikiHttpServerOptions {
  host?: string;
  port?: number;
  wikiRoot: string;
  logFile?: string;
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
  response.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, MCP-Session-Id');
  response.setHeader('Access-Control-Expose-Headers', 'MCP-Session-Id');
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

async function appendHttpLog(
  logFile: string,
  entry: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(logFile), { recursive: true });
  await appendFile(logFile, `${JSON.stringify(entry)}\n`, 'utf8');
}

function getLogEntryBody(body: unknown): { method?: string; toolName?: string; argumentNames: string[] } {
  if (!body || typeof body !== 'object') {
    return { argumentNames: [] };
  }

  const request = body as {
    method?: unknown;
    params?: {
      name?: unknown;
      arguments?: unknown;
    };
  };
  const argumentsValue = request.params?.arguments;
  const argumentNames = argumentsValue && typeof argumentsValue === 'object'
    ? Object.keys(argumentsValue).sort()
    : [];

  return {
    method: typeof request.method === 'string' ? request.method : undefined,
    toolName: typeof request.params?.name === 'string' ? request.params.name : undefined,
    argumentNames,
  };
}

export function createLlmWikiHttpServer(options: LlmWikiHttpServerOptions) {
  const host = options.host ?? '127.0.0.1';
  const logFile = options.logFile ?? join(options.wikiRoot, 'logs', 'mcp-http.jsonl');
  const sessions = new Map<string, HttpSession>();

  const trackResponse = (session: HttpSession, response: ServerResponse): void => {
    session.openResponses++;
    session.lastActive = Date.now();
    response.on('close', () => {
      session.openResponses = Math.max(0, session.openResponses - 1);
      session.lastActive = Date.now();
    });
  };

  const httpServer = createServer(async (request, response) => {
    setCorsHeaders(response);

    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, {
        status: 'ok',
        server: 'llmwiki',
        wikiRoot: options.wikiRoot,
      });
      return;
    }

    if (url.pathname !== '/mcp') {
      sendJson(response, 404, {
        jsonrpc: '2.0',
        error: { code: -32601, message: 'Endpoint not found' },
        id: null,
      });
      return;
    }

    try {
      const sessionId = request.headers['mcp-session-id'];
      const sessionIdValue = Array.isArray(sessionId) ? sessionId[0] : sessionId;

      if (request.method === 'POST') {
        const body = await readJsonBody(request);
        const logEntryBody = getLogEntryBody(body);
        if (logEntryBody.method === 'initialize') {
          void appendHttpLog(logFile, {
            timestamp: new Date().toISOString(),
            action: 'initialize',
          }).catch((error: unknown) => {
            console.error('Failed to append MCP HTTP log:', error);
          });
        }
        if (logEntryBody.method === 'tools/call' && logEntryBody.toolName) {
          void appendHttpLog(logFile, {
            timestamp: new Date().toISOString(),
            action: 'tool_call',
            tool: logEntryBody.toolName,
            argumentNames: logEntryBody.argumentNames,
          }).catch((error: unknown) => {
            console.error('Failed to append MCP HTTP log:', error);
          });
        }
        const existingSession = sessionIdValue ? sessions.get(sessionIdValue) : undefined;

        if (existingSession) {
          trackResponse(existingSession, response);
          await existingSession.transport.handleRequest(request, response, body);
          return;
        }

        if (!sessionIdValue && isInitializeRequest(body)) {
          if (sessions.size >= 100) {
            sendJson(response, 503, {
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Too many open MCP sessions' },
              id: null,
            });
            return;
          }

          const server = createMcpServer(options.wikiRoot);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (initializedSessionId: string) => {
            const session: HttpSession = {
              transport,
              server,
              openResponses: 0,
              lastActive: Date.now(),
            };
            sessions.set(initializedSessionId, session);
            },
          });

          transport.onclose = () => {
            if (transport.sessionId) {
              sessions.delete(transport.sessionId);
            }
          };

          await server.connect(transport);
          await transport.handleRequest(request, response, body);
          return;
        }

        if (sessionIdValue) {
          sendJson(response, 404, {
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null,
          });
          return;
        }

        sendJson(response, 400, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Invalid MCP request' },
          id: null,
        });
        return;
      }

      if (request.method === 'DELETE' && sessionIdValue) {
        const existingSession = sessions.get(sessionIdValue);
        if (!existingSession) {
          sendJson(response, 404, {
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null,
          });
          return;
        }

        await existingSession.transport.close();
        await existingSession.server.close();
        sessions.delete(sessionIdValue);
        response.statusCode = 204;
        response.end();
        return;
      }

      if (request.method === 'GET' && sessionIdValue) {
        const existingSession = sessions.get(sessionIdValue);
        if (!existingSession) {
          sendJson(response, 404, {
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null,
          });
          return;
        }

        trackResponse(existingSession, response);
        await existingSession.transport.handleRequest(request, response);
        return;
      }

      response.statusCode = 405;
      response.setHeader('Allow', 'POST, DELETE');
      sendJson(response, 405, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed' },
        id: null,
      });
    } catch (error) {
      if (!response.headersSent) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message },
          id: null,
        });
      }
    }
  });

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [sessionId, session] of sessions) {
      if (session.openResponses === 0 && session.lastActive < cutoff) {
        void session.transport.close();
        void session.server.close();
        sessions.delete(sessionId);
      }
    }
  }, 60 * 1000);
  cleanupTimer.unref();

  return httpServer;
}
