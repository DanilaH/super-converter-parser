import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildOutputDiagnostics } from '../outputs/outputDiagnostics.js';
import { ResearchError } from '../shared/errors.js';
import { listResearchCatalog } from '../application/researchCatalog.js';
import { inspectResearchConsole } from '../application/researchConsole.js';
import { UiJobBusyError, UiJobRegistry } from './jobs.js';
import {
  executeUiResearchDraft,
  executeUiResearchResume,
  previewUiResearchDraft,
} from './researchExecution.js';

const DEFAULT_PORT = 4173;
const HOST = '127.0.0.1';
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

export type UiServerOptions = {
  port?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  openBrowser?: boolean;
  deps?: UiServerDeps;
  jobs?: UiJobRegistry;
};

export type StartedUiServer = {
  server: Server;
  url: string;
  close: () => Promise<void>;
};

type StaticAsset = { contentType: string; body: Buffer };

export type UiServerDeps = {
  buildOutputDiagnostics: typeof buildOutputDiagnostics;
  listResearchCatalog: typeof listResearchCatalog;
  inspectResearchConsole: typeof inspectResearchConsole;
  previewUiResearchDraft: typeof previewUiResearchDraft;
  executeUiResearchDraft: typeof executeUiResearchDraft;
  executeUiResearchResume: typeof executeUiResearchResume;
  loadStaticAssets: () => Promise<Map<string, StaticAsset>>;
  openBrowser: (url: string) => void;
};

export const DEFAULT_UI_SERVER_DEPS: UiServerDeps = {
  buildOutputDiagnostics,
  listResearchCatalog,
  inspectResearchConsole,
  previewUiResearchDraft,
  executeUiResearchDraft,
  executeUiResearchResume,
  loadStaticAssets,
  openBrowser: openBrowserBestEffort,
};

export async function startUiServer(options: UiServerOptions = {}): Promise<StartedUiServer> {
  const env = options.env ?? process.env;
  const deps = options.deps ?? DEFAULT_UI_SERVER_DEPS;
  const jobs = options.jobs ?? new UiJobRegistry();
  const port = options.port ?? parsePort(env.RESEARCH_UI_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `UI server port must be an integer from 0 to 65535; received ${port}.`);
  }
  const assets = await deps.loadStaticAssets();
  const diagnosticsInput = options.cwd === undefined ? { env } : { env, cwd: options.cwd };
  const diagnostics = await deps.buildOutputDiagnostics(diagnosticsInput);
  const outputRoot = diagnostics.canonicalRoot;
  let boundPort = port;

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', `http://${HOST}:${boundPort}`);
      if (request.method === 'GET') {
        await handleGet(requestUrl, response, {
          deps,
          jobs,
          outputRoot,
          env,
          diagnosticsInput,
          assets,
        });
        return;
      }

      if (request.method === 'POST') {
        assertMutationOrigin(request, boundPort);
        const body = await readJsonBody(request);
        await handlePost(requestUrl, response, body, {
          deps,
          jobs,
          outputRoot,
          env,
        });
        return;
      }

      throw new UiHttpError(405, 'METHOD_NOT_ALLOWED', 'Only GET and POST are supported.');
    } catch (error) {
      sendError(response, error);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('UI server did not expose a TCP address.');
  }
  boundPort = address.port;
  const url = `http://${HOST}:${address.port}`;
  const shouldOpenBrowser = options.openBrowser ?? env.RESEARCH_UI_NO_OPEN?.trim().toLowerCase() !== 'true';
  if (shouldOpenBrowser) deps.openBrowser(url);
  return {
    server,
    url,
    close: () => closeServer(server),
  };
}

async function handleGet(
  requestUrl: URL,
  response: ServerResponse,
  context: {
    deps: UiServerDeps;
    jobs: UiJobRegistry;
    outputRoot: string;
    env: NodeJS.ProcessEnv;
    diagnosticsInput: Parameters<typeof buildOutputDiagnostics>[0];
    assets: Map<string, StaticAsset>;
  },
): Promise<void> {
  if (requestUrl.pathname === '/api/researches') {
    const items = await context.deps.listResearchCatalog(context.outputRoot);
    const query = requestUrl.searchParams.get('q')?.trim().toLowerCase() ?? '';
    const filtered = query === '' ? items : items.filter((item) => matchesCatalogQuery(item, query));
    sendJson(response, 200, { version: 1, researches: filtered });
    return;
  }

  if (requestUrl.pathname === '/api/jobs') {
    sendJson(response, 200, { version: 1, jobs: context.jobs.list() });
    return;
  }

  if (requestUrl.pathname.startsWith('/api/jobs/')) {
    const jobId = decodeRouteId(requestUrl.pathname.slice('/api/jobs/'.length), 'job');
    const job = context.jobs.get(jobId);
    if (job === null) throw new UiHttpError(404, 'NOT_FOUND', `UI job not found: ${jobId}.`);
    sendJson(response, 200, { version: 1, job });
    return;
  }

  if (requestUrl.pathname.startsWith('/api/researches/')) {
    const researchId = decodeRouteId(requestUrl.pathname.slice('/api/researches/'.length), 'research');
    const detail = await context.deps.inspectResearchConsole(researchId, {
      outputRoot: context.outputRoot,
      env: context.env,
    });
    sendJson(response, 200, detail);
    return;
  }

  if (requestUrl.pathname === '/api/system') {
    const current = await context.deps.buildOutputDiagnostics(context.diagnosticsInput);
    sendJson(response, 200, { version: 1, outputs: current });
    return;
  }

  const asset = context.assets.get(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
  if (asset) {
    sendStatic(response, asset);
    return;
  }

  throw new UiHttpError(404, 'NOT_FOUND', 'Route not found.');
}

async function handlePost(
  requestUrl: URL,
  response: ServerResponse,
  body: unknown,
  context: {
    deps: UiServerDeps;
    jobs: UiJobRegistry;
    outputRoot: string;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  if (requestUrl.pathname === '/api/researches/plan') {
    const plan = await context.deps.previewUiResearchDraft(body);
    sendJson(response, 200, { version: 1, plan });
    return;
  }

  if (requestUrl.pathname === '/api/researches') {
    const plan = await context.deps.previewUiResearchDraft(body);
    const job = context.jobs.start('create_research', null, (control) =>
      context.deps.executeUiResearchDraft(body, {
        outputRoot: context.outputRoot,
        env: context.env,
        onResearchInitialized: ({ researchId }) => control.setResearchId(researchId),
      }));
    sendJson(response, 202, { version: 1, job, plan });
    return;
  }

  const resumeMatch = /^\/api\/researches\/([^/]+)\/resume$/.exec(requestUrl.pathname);
  if (resumeMatch) {
    assertEmptyObject(body, 'Resume request body');
    const researchId = decodeRouteId(resumeMatch[1] ?? '', 'research');
    await context.deps.inspectResearchConsole(researchId, {
      outputRoot: context.outputRoot,
      env: context.env,
    });
    const job = context.jobs.start('resume_research', researchId, () =>
      context.deps.executeUiResearchResume(researchId, {
        outputRoot: context.outputRoot,
        env: context.env,
      }));
    sendJson(response, 202, { version: 1, job });
    return;
  }

  throw new UiHttpError(404, 'NOT_FOUND', 'Mutation route not found.');
}

async function loadStaticAssets(): Promise<Map<string, StaticAsset>> {
  const base = new URL('./public/', import.meta.url);
  const specs: Array<[string, string, string]> = [
    ['/index.html', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
  ];
  const entries = await Promise.all(specs.map(async ([route, file, contentType]) => [
    route,
    { contentType, body: await readFile(fileURLToPath(new URL(file, base))) },
  ] as const));
  return new Map(entries);
}

function matchesCatalogQuery(
  item: Awaited<ReturnType<typeof listResearchCatalog>>[number],
  query: string,
): boolean {
  return item.label.toLowerCase().includes(query)
    || item.researchId.toLowerCase().includes(query)
    || item.currentRunId.toLowerCase().includes(query)
    || item.knownRunIds.some((id) => id.toLowerCase().includes(query));
}

function assertMutationOrigin(request: IncomingMessage, boundPort: number): void {
  const raw = request.headers.origin;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new UiHttpError(403, 'ORIGIN_NOT_ALLOWED', 'Mutation requests require a same-origin loopback Origin header.');
  }

  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    throw new UiHttpError(403, 'ORIGIN_NOT_ALLOWED', 'Mutation request Origin is malformed.');
  }
  const originPort = origin.port === '' ? 80 : Number(origin.port);
  const loopbackHost = origin.hostname === HOST || origin.hostname === 'localhost';
  if (origin.protocol !== 'http:' || !loopbackHost || originPort !== boundPort) {
    throw new UiHttpError(403, 'ORIGIN_NOT_ALLOWED', `Mutation Origin is not this local Runner UI: ${raw}.`);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new UiHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Mutation requests require Content-Type: application/json.');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    total += chunk.length;
    if (total > MAX_JSON_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) {
    throw new UiHttpError(413, 'PAYLOAD_TOO_LARGE', `JSON request body exceeds ${MAX_JSON_BODY_BYTES} bytes.`);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UiHttpError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  }
}

function decodeRouteId(encoded: string, kind: string): string {
  if (encoded === '' || encoded.includes('/')) {
    throw new UiHttpError(404, 'NOT_FOUND', `${kind} route not found.`);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new UiHttpError(400, 'INPUT_SCHEMA_ERROR', `Malformed ${kind} identifier.`);
  }
  if (decoded.trim() === '' || decoded.includes('/')) {
    throw new UiHttpError(400, 'INPUT_SCHEMA_ERROR', `Invalid ${kind} identifier.`);
  }
  return decoded;
}

function assertEmptyObject(value: unknown, label: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== 0) {
    throw new UiHttpError(400, 'INPUT_SCHEMA_ERROR', `${label} must be an empty JSON object.`);
  }
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof UiHttpError) {
    sendJson(response, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof UiJobBusyError) {
    sendJson(response, 409, {
      error: {
        code: 'UI_JOB_BUSY',
        message: error.message,
        activeJob: error.activeJob,
      },
    });
    return;
  }
  const status = error instanceof ResearchError && error.code === 'RESUME_NOT_FOUND'
    ? 404
    : error instanceof ResearchError && error.code === 'INPUT_SCHEMA_ERROR'
      ? 400
      : 500;
  const code = error instanceof ResearchError ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  sendJson(response, status, { error: { code, message } });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  setSecurityHeaders(response);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendStatic(response: ServerResponse, asset: StaticAsset): void {
  setSecurityHeaders(response);
  response.writeHead(200, {
    'Content-Type': asset.contentType,
    'Content-Length': asset.body.length,
    'Cache-Control': 'no-store',
  });
  response.end(asset.body);
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `RESEARCH_UI_PORT must be an integer from 1 to 65535; received ${raw}.`);
  }
  return parsed;
}

function openBrowserBestEffort(url: string): void {
  const command = process.platform === 'win32'
    ? { executable: 'cmd', args: ['/c', 'start', '', url] }
    : process.platform === 'darwin'
      ? { executable: 'open', args: [url] }
      : { executable: 'xdg-open', args: [url] };
  try {
    const child = spawn(command.executable, command.args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Browser opening is convenience only; the server remains usable via the printed URL.
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

class UiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UiHttpError';
  }
}

async function main(): Promise<void> {
  try {
    const started = await startUiServer();
    console.log(`Runner UI: ${started.url}`);
    console.log('Local Runner console. Press Ctrl+C to stop.');
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();