import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OperatorGuiService, type GuiDraftFiles } from './service.js';
import { ResearchError } from '../shared/errors.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_STATIC_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'public');

type GuiServiceLike = Pick<
  OperatorGuiService,
  'bootstrap' | 'listResearches' | 'status' | 'planNew' | 'runNew' | 'planExisting' | 'runExisting'
>;

export type OperatorGuiServer = {
  server: Server;
  url: string;
  close: () => Promise<void>;
};

export async function startOperatorGuiServer(input: {
  service: GuiServiceLike;
  host?: string;
  port?: number;
  staticRoot?: string;
}): Promise<OperatorGuiServer> {
  const host = input.host ?? DEFAULT_HOST;
  if (host !== DEFAULT_HOST) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Operator GUI must bind to ${DEFAULT_HOST}; received ${host}.`);
  }
  const requestedPort = input.port ?? DEFAULT_PORT;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Invalid GUI port: ${requestedPort}.`);
  }
  const staticRoot = input.staticRoot ?? DEFAULT_STATIC_ROOT;
  const server = createServer((request, response) => {
    void handleRequest(request, response, input.service, staticRoot).catch((error) => sendError(response, error));
  });

  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(requestedPort, host, () => {
      server.off('error', onError);
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new ResearchError('OUTPUT_WRITE_ERROR', 'Operator GUI server did not expose a TCP address.');
  }
  const url = `http://${host}:${address.port}`;
  return {
    server,
    url,
    close: () => new Promise<void>((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: GuiServiceLike,
  staticRoot: string,
): Promise<void> {
  assertLoopbackHost(request);
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const method = request.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/api/bootstrap') {
    sendJson(response, 200, await service.bootstrap());
    return;
  }
  if (method === 'GET' && url.pathname === '/api/researches') {
    sendJson(response, 200, await service.listResearches());
    return;
  }

  const statusMatch = url.pathname.match(/^\/api\/researches\/([^/]+)\/status$/);
  if (method === 'GET' && statusMatch) {
    sendJson(response, 200, await service.status(decodeURIComponent(statusMatch[1] as string)));
    return;
  }

  if (method === 'POST') assertMutationOrigin(request);

  if (method === 'POST' && url.pathname === '/api/new/plan') {
    const body = await readJsonBody(request);
    sendJson(response, 200, await service.planNew(body.config, readFiles(body.files)));
    return;
  }
  if (method === 'POST' && url.pathname === '/api/new/run') {
    const body = await readJsonBody(request);
    sendJson(response, 200, await service.runNew(readString(body.draftId, 'draftId')));
    return;
  }

  const existingPlanMatch = url.pathname.match(/^\/api\/researches\/([^/]+)\/plan$/);
  if (method === 'POST' && existingPlanMatch) {
    const researchId = decodeURIComponent(existingPlanMatch[1] as string);
    const body = await readJsonBody(request);
    const continuation = Object.prototype.hasOwnProperty.call(body, 'continuation') ? body.continuation : null;
    sendJson(response, 200, await service.planExisting(researchId, continuation, readFiles(body.files)));
    return;
  }

  const existingRunMatch = url.pathname.match(/^\/api\/researches\/([^/]+)\/run$/);
  if (method === 'POST' && existingRunMatch) {
    const researchId = decodeURIComponent(existingRunMatch[1] as string);
    const body = await readJsonBody(request);
    const draftId = body.draftId === null || body.draftId === undefined
      ? null
      : readString(body.draftId, 'draftId');
    sendJson(response, 200, await service.runExisting(researchId, draftId));
    return;
  }

  if (method === 'GET') {
    const asset = staticAsset(url.pathname);
    if (asset !== null) {
      const content = await readFile(join(staticRoot, asset.file));
      response.writeHead(200, {
        'content-type': asset.contentType,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(content);
      return;
    }
  }

  sendJson(response, 404, { error: { code: 'NOT_FOUND', message: `${method} ${url.pathname} not found.` } });
}

function assertLoopbackHost(request: IncomingMessage): void {
  const raw = request.headers.host ?? '';
  const hostname = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0];
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    throw new HttpError(403, 'FORBIDDEN', 'Operator GUI accepts loopback Host headers only.');
  }
}

function assertMutationOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin;
  if (origin === undefined) return;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError(403, 'FORBIDDEN', 'Invalid Origin header.');
  }
  if (parsed.protocol !== 'http:' || (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')) {
    throw new HttpError(403, 'FORBIDDEN', 'Operator GUI mutation requests must come from the loopback origin.');
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Operator GUI API accepts application/json request bodies only.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Operator GUI JSON body exceeds ${MAX_JSON_BODY_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    throw new HttpError(400, 'INVALID_JSON', error instanceof Error ? error.message : 'Invalid JSON body.');
  }
  if (!isRecord(parsed)) throw new HttpError(400, 'INVALID_JSON', 'Operator GUI request body must be a JSON object.');
  return parsed;
}

function readFiles(value: unknown): GuiDraftFiles {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new HttpError(400, 'INVALID_FILES', 'files must be an object mapping relative paths to text content.');
  const files: GuiDraftFiles = {};
  for (const [path, content] of Object.entries(value)) {
    if (typeof content !== 'string') throw new HttpError(400, 'INVALID_FILES', `files.${path} must be a string.`);
    files[path] = content;
  }
  return files;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'INVALID_REQUEST', `${field} must be a non-empty string.`);
  }
  return value;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  if (error instanceof HttpError) {
    sendJson(response, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ResearchError) {
    const inputError = error.code === 'INPUT_SCHEMA_ERROR' || error.code === 'RESUME_NOT_FOUND' || error.code === 'RESUME_CONFIG_MISMATCH';
    sendJson(response, inputError ? 400 : 500, { error: { code: error.code, message: error.message } });
    return;
  }
  sendJson(response, 500, { error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } });
}

function staticAsset(pathname: string): { file: string; contentType: string } | null {
  if (pathname === '/' || pathname === '/index.html') return { file: 'index.html', contentType: 'text/html; charset=utf-8' };
  if (pathname === '/app.js') return { file: 'app.js', contentType: 'text/javascript; charset=utf-8' };
  if (pathname === '/styles.css') return { file: 'styles.css', contentType: 'text/css; charset=utf-8' };
  return null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCliArgs(argv: string[]): { port: number; outputRoot: string | null } {
  const args = [...argv];
  let port = DEFAULT_PORT;
  let outputRoot: string | null = null;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--port') {
      const raw = args.shift();
      if (raw === undefined) throw new ResearchError('INPUT_SCHEMA_ERROR', '--port requires a value.');
      port = Number(raw);
    } else if (arg === '--output-root') {
      const raw = args.shift();
      if (raw === undefined) throw new ResearchError('INPUT_SCHEMA_ERROR', '--output-root requires a value.');
      outputRoot = raw;
    } else {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown GUI argument: ${arg ?? ''}.`);
    }
  }
  return { port, outputRoot };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const service = await OperatorGuiService.create({ outputRoot: args.outputRoot });
  const gui = await startOperatorGuiServer({ service, port: args.port });
  console.log(`Utility Research Runner GUI: ${gui.url}`);
  console.log(`Output root: ${service.outputRoot}`);
  console.log('Press Ctrl+C to stop the local GUI.');

  const shutdown = async () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await gui.close().catch(() => undefined);
    await service.close().catch(() => undefined);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
