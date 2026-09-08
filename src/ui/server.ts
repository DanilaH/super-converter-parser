import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildOutputDiagnostics } from '../outputs/outputDiagnostics.js';
import { ResearchError } from '../shared/errors.js';
import { listResearchCatalog } from '../application/researchCatalog.js';
import { inspectResearchConsole } from '../application/researchConsole.js';

const DEFAULT_PORT = 4173;
const HOST = '127.0.0.1';

export type UiServerOptions = {
  port?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  openBrowser?: boolean;
  deps?: UiServerDeps;
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
  loadStaticAssets: () => Promise<Map<string, StaticAsset>>;
  openBrowser: (url: string) => void;
};

export const DEFAULT_UI_SERVER_DEPS: UiServerDeps = {
  buildOutputDiagnostics,
  listResearchCatalog,
  inspectResearchConsole,
  loadStaticAssets,
  openBrowser: openBrowserBestEffort,
};

export async function startUiServer(options: UiServerOptions = {}): Promise<StartedUiServer> {
  const env = options.env ?? process.env;
  const deps = options.deps ?? DEFAULT_UI_SERVER_DEPS;
  const port = options.port ?? parsePort(env.RESEARCH_UI_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `UI server port must be an integer from 0 to 65535; received ${port}.`);
  }
  const assets = await deps.loadStaticAssets();
  const diagnostics = await deps.buildOutputDiagnostics({ env, cwd: options.cwd });
  const outputRoot = diagnostics.canonicalRoot;

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', `http://${HOST}:${port}`);
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'The U1 console is read-only.' } });
        return;
      }

      if (requestUrl.pathname === '/api/researches') {
        const items = await deps.listResearchCatalog(outputRoot);
        const query = requestUrl.searchParams.get('q')?.trim().toLowerCase() ?? '';
        const filtered = query === '' ? items : items.filter((item) => matchesCatalogQuery(item, query));
        sendJson(response, 200, { version: 1, researches: filtered });
        return;
      }

      if (requestUrl.pathname.startsWith('/api/researches/')) {
        const encoded = requestUrl.pathname.slice('/api/researches/'.length);
        if (encoded === '' || encoded.includes('/')) {
          sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Research route not found.' } });
          return;
        }
        let researchId: string;
        try {
          researchId = decodeURIComponent(encoded);
        } catch {
          sendJson(response, 400, { error: { code: 'INPUT_SCHEMA_ERROR', message: 'Malformed research identifier.' } });
          return;
        }
        const detail = await deps.inspectResearchConsole(researchId, { outputRoot, env });
        sendJson(response, 200, detail);
        return;
      }

      if (requestUrl.pathname === '/api/system') {
        const current = await deps.buildOutputDiagnostics({ env, cwd: options.cwd });
        sendJson(response, 200, { version: 1, outputs: current });
        return;
      }

      const asset = assets.get(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
      if (asset) {
        sendStatic(response, asset);
        return;
      }

      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } });
    } catch (error) {
      const status = error instanceof ResearchError && error.code === 'RESUME_NOT_FOUND'
        ? 404
        : error instanceof ResearchError && error.code === 'INPUT_SCHEMA_ERROR'
          ? 400
          : 500;
      const code = error instanceof ResearchError ? error.code : 'INTERNAL_ERROR';
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, status, { error: { code, message } });
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
  const url = `http://${HOST}:${address.port}`;
  const shouldOpenBrowser = options.openBrowser ?? env.RESEARCH_UI_NO_OPEN?.trim().toLowerCase() !== 'true';
  if (shouldOpenBrowser) deps.openBrowser(url);
  return {
    server,
    url,
    close: () => closeServer(server),
  };
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
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
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

async function main(): Promise<void> {
  try {
    const started = await startUiServer();
    console.log(`Runner UI: ${started.url}`);
    console.log('Read-only U1 console. Press Ctrl+C to stop.');
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
