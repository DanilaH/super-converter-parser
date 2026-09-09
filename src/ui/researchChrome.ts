import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9333';
const DEFAULT_PROFILE_ROOT = 'C:\\tmp\\research-profile';
const CDP_STATUS_TIMEOUT_MS = 750;
const MAX_PROCESS_OUTPUT_BYTES = 32 * 1024;

export type ResearchChromeStatus = {
  version: 1;
  endpoint: string;
  connected: boolean;
  browser: string | null;
  profileRoot: string;
  profileReady: boolean | null;
  controlSupported: boolean;
  controlReason: string | null;
  configurationError: string | null;
};

type ResearchChromeScriptMode = 'setup' | 'start';

type ResearchChromeRuntime = {
  platform: NodeJS.Platform;
  accessPath: (path: string) => Promise<void>;
  fetchImpl: typeof fetch;
  runScript: (input: { mode: ResearchChromeScriptMode; profileRoot: string; port: number }) => Promise<void>;
};

export type ResearchChromeOptions = {
  env?: NodeJS.ProcessEnv;
  runtime?: Partial<ResearchChromeRuntime>;
};

export async function inspectResearchChrome(options: ResearchChromeOptions = {}): Promise<ResearchChromeStatus> {
  const env = options.env ?? process.env;
  const runtime = resolveRuntime(options.runtime);
  const profileRoot = DEFAULT_PROFILE_ROOT;
  const parsed = parseCdpConfiguration(env.CDP_URL);
  const profileReady = runtime.platform === 'win32'
    ? await pathExists(join(profileRoot, 'Default'), runtime.accessPath)
    : null;

  if (parsed.error !== null) {
    return {
      version: 1,
      endpoint: parsed.raw,
      connected: false,
      browser: null,
      profileRoot,
      profileReady,
      controlSupported: false,
      controlReason: parsed.error,
      configurationError: parsed.error,
    };
  }

  const connection = await inspectCdp(parsed.statusUrl, runtime.fetchImpl);
  const platformSupported = runtime.platform === 'win32';
  const controlSupported = platformSupported && parsed.localControlPort !== null;
  const controlReason = !platformSupported
    ? 'Built-in Research Chrome setup/start is currently available on Windows only.'
    : parsed.localControlPort === null
      ? 'Built-in control requires CDP_URL to use loopback HTTP with an explicit local port.'
      : null;

  return {
    version: 1,
    endpoint: parsed.origin,
    connected: connection.connected,
    browser: connection.browser,
    profileRoot,
    profileReady,
    controlSupported,
    controlReason,
    configurationError: null,
  };
}

export async function setupResearchChrome(options: ResearchChromeOptions = {}): Promise<ResearchChromeStatus> {
  const env = options.env ?? process.env;
  const runtime = resolveRuntime(options.runtime);
  const configuration = requireControllableConfiguration(env.CDP_URL, runtime.platform);
  const before = await inspectResearchChrome({ env, runtime });

  if (before.profileReady === true) return before;
  if (before.connected) {
    throw new Error('Research Chrome is already connected, but its managed profile is not present. Stop that Chrome instance before running Setup.');
  }

  await runtime.runScript({
    mode: 'setup',
    profileRoot: before.profileRoot,
    port: configuration.port,
  });
  const after = await inspectResearchChrome({ env, runtime });
  if (after.profileReady !== true) {
    throw new Error(`Research Chrome setup finished, but the managed profile was not found at ${after.profileRoot}.`);
  }
  return after;
}

export async function startResearchChrome(options: ResearchChromeOptions = {}): Promise<ResearchChromeStatus> {
  const env = options.env ?? process.env;
  const runtime = resolveRuntime(options.runtime);
  const configuration = requireControllableConfiguration(env.CDP_URL, runtime.platform);
  const before = await inspectResearchChrome({ env, runtime });

  if (before.connected) return before;
  if (before.profileReady !== true) {
    throw new Error('Research Chrome profile is missing. Run Setup Research Chrome once before starting it.');
  }

  await runtime.runScript({
    mode: 'start',
    profileRoot: before.profileRoot,
    port: configuration.port,
  });
  const after = await inspectResearchChrome({ env, runtime });
  if (!after.connected) {
    throw new Error(`Research Chrome start finished, but CDP is still unavailable at ${after.endpoint}.`);
  }
  return after;
}

function resolveRuntime(overrides: Partial<ResearchChromeRuntime> | undefined): ResearchChromeRuntime {
  return {
    platform: overrides?.platform ?? process.platform,
    accessPath: overrides?.accessPath ?? (async (path) => access(path)),
    fetchImpl: overrides?.fetchImpl ?? fetch,
    runScript: overrides?.runScript ?? runResearchChromeScript,
  };
}

function parseCdpConfiguration(rawValue: string | undefined): {
  raw: string;
  origin: string;
  statusUrl: string;
  localControlPort: number | null;
  error: string | null;
} {
  const raw = rawValue?.trim() || DEFAULT_CDP_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      raw,
      origin: raw,
      statusUrl: raw,
      localControlPort: null,
      error: `CDP_URL is not a valid URL: ${raw}`,
    };
  }

  const origin = url.origin;
  const statusUrl = new URL('/json/version', origin).href;
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  const port = url.port === '' ? null : Number(url.port);
  const localControlPort = url.protocol === 'http:' && loopback && Number.isInteger(port) && port !== null && port >= 1 && port <= 65_535
    ? port
    : null;
  return { raw, origin, statusUrl, localControlPort, error: null };
}

function requireControllableConfiguration(rawValue: string | undefined, platform: NodeJS.Platform): { port: number } {
  if (platform !== 'win32') {
    throw new Error('Built-in Research Chrome setup/start is currently available on Windows only.');
  }
  const parsed = parseCdpConfiguration(rawValue);
  if (parsed.error !== null) throw new Error(parsed.error);
  if (parsed.localControlPort === null) {
    throw new Error('Built-in Research Chrome control requires CDP_URL to use loopback HTTP with an explicit local port.');
  }
  return { port: parsed.localControlPort };
}

async function pathExists(path: string, accessPath: ResearchChromeRuntime['accessPath']): Promise<boolean> {
  try {
    await accessPath(path);
    return true;
  } catch {
    return false;
  }
}

async function inspectCdp(statusUrl: string, fetchImpl: typeof fetch): Promise<{ connected: boolean; browser: string | null }> {
  try {
    const response = await fetchImpl(statusUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CDP_STATUS_TIMEOUT_MS),
    });
    if (!response.ok) return { connected: false, browser: null };
    const payload = await response.json() as { Browser?: unknown };
    return {
      connected: true,
      browser: typeof payload.Browser === 'string' && payload.Browser.trim() !== '' ? payload.Browser : null,
    };
  } catch {
    return { connected: false, browser: null };
  }
}

function runResearchChromeScript(input: {
  mode: ResearchChromeScriptMode;
  profileRoot: string;
  port: number;
}): Promise<void> {
  const scriptPath = fileURLToPath(new URL('../../scripts/research-chrome.ps1', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-Mode', input.mode,
      '-ProfileRoot', input.profileRoot,
      '-Port', String(input.port),
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim() || stdout.trim();
      reject(new Error(`Research Chrome ${input.mode} failed with exit code ${code ?? 'unknown'}${detail ? `: ${detail}` : '.'}`));
    });
  });
}

function appendBounded(current: string, chunk: Buffer | string): string {
  if (Buffer.byteLength(current, 'utf8') >= MAX_PROCESS_OUTPUT_BYTES) return current;
  const next = current + String(chunk);
  if (Buffer.byteLength(next, 'utf8') <= MAX_PROCESS_OUTPUT_BYTES) return next;
  return Buffer.from(next, 'utf8').subarray(0, MAX_PROCESS_OUTPUT_BYTES).toString('utf8');
}
