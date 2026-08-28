import { Agent, fetch as undiciFetch } from 'undici';
import { isIP } from 'node:net';
import { isPrivateIp } from './ssrf.js';

type Response = any;

export type DnsResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export type SsrfCheckResult = {
  allowed: boolean;
  reason?: string;
  ip?: string;
  kind?: 'ok' | 'blocked' | 'timeout' | 'error';
};

export type SsrfChecker = (url: string) => Promise<SsrfCheckResult>;

export type FetcherConfig = {
  maxRedirects: number;
  timeoutMs: number;
  maxBytes: number;
  maxTextBytes: number;
  userAgent: string;
  respectRetryAfter: boolean;
  minDomainDelayMs: number;
  maxDomainDelayMs: number;
  ssrfChecker?: SsrfChecker;
  dnsResolver?: DnsResolver;
  ipPolicy?: IpPolicy;
  ca?: string;
  maxRetries: number;
  baseRetryDelayMs: number;
};

export const DEFAULT_FETCHER_CONFIG: FetcherConfig = {
  maxRedirects: 5,
  timeoutMs: 15_000,
  maxBytes: 2_000_000,
  maxTextBytes: 500_000,
  userAgent: 'UtilityResearchRunner/1.0 (+https://local.dev)',
  respectRetryAfter: true,
  minDomainDelayMs: 500,
  maxDomainDelayMs: 2000,
  maxRetries: 2,
  baseRetryDelayMs: 1000,
};

export type FetchFailureReason = 'timeout' | 'oversized' | 'read_error' | 'network' | 'blocked' | 'rate_limited' | 'too_many_redirects';

export type FetchResult = {
  status: number;
  contentType: string | null;
  finalUrl: string;
  redirectChain: string[];
  body: string | null;
  error: string | null;
  aborted: boolean;
  retryAfter: string | null;
  bodyError: boolean;
  failureReason: FetchFailureReason | null;
};

type DomainState = {
  lastRequestAt: number;
};

const domainStates = new Map<string, DomainState>();

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function applyDomainDelay(domain: string, config: FetcherConfig): Promise<void> {
  if (config.minDomainDelayMs <= 0) return;

  const now = Date.now();
  const state = domainStates.get(domain);
  const elapsed = state ? now - state.lastRequestAt : Infinity;
  const requiredDelay = config.minDomainDelayMs + Math.random() * (config.maxDomainDelayMs - config.minDomainDelayMs);

  if (elapsed < requiredDelay) {
    await new Promise((resolve) => setTimeout(resolve, requiredDelay - elapsed));
  }

  domainStates.set(domain, { lastRequestAt: Date.now() });
}

export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const asNumber = Number(header);
  if (!Number.isNaN(asNumber) && asNumber >= 0) {
    return asNumber * 1000;
  }
  const asDate = new Date(header);
  if (!Number.isNaN(asDate.getTime())) {
    return Math.max(0, asDate.getTime() - Date.now());
  }
  return null;
}

export function resolveRetryDelayMs(
  retryAfter: string | null,
  fallbackMs: number,
  maxDelayMs: number,
): number {
  const requestedMs = parseRetryAfter(retryAfter) ?? fallbackMs;
  return Math.min(requestedMs, Math.max(0, maxDelayMs));
}

interface PinnedConnectContext {
  validatedIp: string;
  servername: string;
  ca?: string;
}

function createPinnedAgent(ctx: PinnedConnectContext): Agent {
  const family = isIP(ctx.validatedIp);
  return new Agent({
    connect: {
      lookup: (_hostname: string, _opts: any, cb: any) => {
        if (_opts.all) {
          cb(null, [{ address: ctx.validatedIp, family: family || 4 }]);
        } else {
          cb(null, ctx.validatedIp, family || 4);
        }
      },
      ...(ctx.ca ? { ca: ctx.ca, rejectUnauthorized: true } : {}),
      servername: ctx.servername,
    },
  });
}

async function readBody(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<{ content: string | null; error: string | null; aborted: boolean; bodyError: boolean; failureReason: FetchFailureReason | null }> {
  if (!response.body) {
    try {
      const text = await response.text();
      if (text.length > maxBytes) {
        return { content: null, error: `Body exceeded ${maxBytes} bytes`, aborted: true, bodyError: true, failureReason: 'oversized' };
      }
      return { content: text, error: null, aborted: false, bodyError: false, failureReason: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = controller.signal.aborted || message.includes('abort');
      return {
        content: null,
        error: `Failed to read response body: ${message}`,
        aborted: isTimeout,
        bodyError: true,
        failureReason: isTimeout ? 'timeout' : 'read_error',
      };
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let totalBytes = 0;
  let result = '';

  const abortPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
  });

  try {
    while (true) {
      const readPromise = reader.read();
      const { done, value } = await Promise.race([readPromise, abortPromise]);
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return { content: null, error: `Body exceeded ${maxBytes} bytes`, aborted: true, bodyError: true, failureReason: 'oversized' };
      }

      result += decoder.decode(value, { stream: true });
    }

    result += decoder.decode();
    return { content: result, error: null, aborted: false, bodyError: false, failureReason: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = controller.signal.aborted || message.includes('abort');
    return {
      content: null,
      error: message,
      aborted: isTimeout,
      bodyError: true,
      failureReason: isTimeout ? 'timeout' : 'read_error',
    };
  } finally {
    reader.cancel().catch(() => {});
  }
}

const DRAIN_MAX_BYTES = 64 * 1024;

async function drainBody(response: Response, controller: AbortController): Promise<void> {
  if (!response.body) {
    await response.text().catch(() => {});
    return;
  }

  const reader = response.body.getReader();
  const abortPromise = new Promise<void>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(), { once: true });
  });

  const drainPromise = (async () => {
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > DRAIN_MAX_BYTES) {
          await reader.cancel();
          break;
        }
      }
    } catch {
      // ignore
    } finally {
      reader.cancel().catch(() => {});
    }
  })();

  await Promise.race([drainPromise, abortPromise]);
}

async function cleanupTerminalResponse(
  response: Response | undefined,
  controller: AbortController,
  timer: ReturnType<typeof setTimeout> | undefined,
): Promise<void> {
  if (response) {
    await drainBody(response, controller);
  }
  if (timer) clearTimeout(timer);
}

export async function boundedFetch(
  url: string,
  config: Partial<FetcherConfig> = {},
): Promise<FetchResult> {
  const cfg = { ...DEFAULT_FETCHER_CONFIG, ...config };
  const defaultChecker = (u: string) => checkUrlAllowed(u, cfg.dnsResolver, cfg.ipPolicy);
  const ssrfCheck = cfg.ssrfChecker ?? defaultChecker;
  const redirectChain: string[] = [];
  let logicalUrl = url;

  const ssrfResult = await ssrfCheck(url);
  if (!ssrfResult.allowed) {
    const failureReason: FetchFailureReason =
      ssrfResult.kind === 'timeout' ? 'timeout' :
      ssrfResult.kind === 'error' ? 'network' : 'blocked';
    const errorPrefix =
      ssrfResult.kind === 'error' ? 'Network error' :
      ssrfResult.kind === 'timeout' ? 'SSRF timeout' : 'SSRF blocked';
    return {
      status: 0,
      contentType: null,
      finalUrl: url,
      redirectChain: [],
      body: null,
      error: `${errorPrefix}: ${ssrfResult.reason}`,
      aborted: false,
      retryAfter: null,
      bodyError: false,
      failureReason,
    };
  }

  let validatedIp: string | undefined = ssrfResult.ip;
  let servername = new URL(url).hostname;
  let dispatcher: Agent | undefined;
  if (validatedIp) {
    dispatcher = createPinnedAgent({ validatedIp, servername, ...(cfg.ca ? { ca: cfg.ca } : {}) });
  }

  const cleanupAgents: Agent[] = [];
  if (dispatcher) cleanupAgents.push(dispatcher);

  try {
    for (let redirect = 0; redirect <= cfg.maxRedirects; redirect++) {
      const domain = getDomain(logicalUrl);
      if (domain) {
        await applyDomainDelay(domain, cfg);
      }

      let response: Response | undefined;
      let retryAfter: string | null = null;
      let attemptController: AbortController | undefined;
      let attemptTimer: ReturnType<typeof setTimeout> | undefined;

      for (let retry = 0; retry <= cfg.maxRetries; retry++) {
        attemptController = new AbortController();
        attemptTimer = setTimeout(() => attemptController!.abort(), cfg.timeoutMs);

        try {
          response = await undiciFetch(logicalUrl, {
            method: 'GET',
            headers: {
              'User-Agent': cfg.userAgent,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.5',
            },
            redirect: 'manual',
            signal: attemptController.signal,
            ...(dispatcher ? { dispatcher } : {}),
          });
        } catch (error) {
          clearTimeout(attemptTimer);
          const message = error instanceof Error ? error.message : String(error);
          if (retry < cfg.maxRetries && message.includes('abort')) {
            await new Promise((resolve) => setTimeout(resolve, cfg.baseRetryDelayMs * (retry + 1)));
            continue;
          }
          return {
            status: 0,
            contentType: null,
            finalUrl: logicalUrl,
            redirectChain,
            body: null,
            error: message,
            aborted: message.includes('abort'),
            retryAfter: null,
            bodyError: false,
            failureReason: message.includes('abort') ? 'timeout' : 'network',
          };
        }

        const { status } = response;
        const contentType = response.headers.get('content-type');
        retryAfter = cfg.respectRetryAfter ? response.headers.get('retry-after') : null;

        if (status === 429 || (status === 503 && retryAfter)) {
          if (retry < cfg.maxRetries) {
            await drainBody(response, attemptController);
            clearTimeout(attemptTimer);
            const delayMs = resolveRetryDelayMs(
              retryAfter,
              cfg.baseRetryDelayMs * (retry + 1),
              cfg.timeoutMs,
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }
          await cleanupTerminalResponse(response, attemptController!, attemptTimer);
          return {
            status,
            contentType,
            finalUrl: logicalUrl,
            redirectChain,
            body: null,
            error: `Rate limited: ${status}`,
            aborted: false,
            retryAfter,
            bodyError: false,
            failureReason: 'rate_limited',
          };
        }

        break;
      }

      if (!response) {
        if (attemptTimer) clearTimeout(attemptTimer);
        return {
          status: 0,
          contentType: null,
          finalUrl: logicalUrl,
          redirectChain,
          body: null,
          error: 'No response after retries',
          aborted: false,
          retryAfter: null,
          bodyError: false,
          failureReason: 'network',
        };
      }

      const { status } = response;
      const contentType = response.headers.get('content-type');
      retryAfter = cfg.respectRetryAfter ? response.headers.get('retry-after') : null;

      if (status >= 300 && status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          await cleanupTerminalResponse(response, attemptController!, attemptTimer);
          return {
            status,
            contentType,
            finalUrl: logicalUrl,
            redirectChain,
            body: null,
            error: 'Redirect without Location header',
            aborted: false,
            retryAfter,
            bodyError: false,
            failureReason: 'network',
          };
        }

        let nextUrl: string;
        try {
          nextUrl = new URL(location, logicalUrl).href;
        } catch {
          await cleanupTerminalResponse(response, attemptController!, attemptTimer);
          return {
            status,
            contentType,
            finalUrl: logicalUrl,
            redirectChain,
            body: null,
            error: `Invalid redirect URL: ${location}`,
            aborted: false,
            retryAfter,
            bodyError: false,
            failureReason: 'network',
          };
        }

        const targetSsrf = await ssrfCheck(nextUrl);
        if (!targetSsrf.allowed) {
          await cleanupTerminalResponse(response, attemptController!, attemptTimer);
          const failureReason: FetchFailureReason =
            targetSsrf.kind === 'timeout' ? 'timeout' :
            targetSsrf.kind === 'error' ? 'network' : 'blocked';
          const errorPrefix =
            targetSsrf.kind === 'error' ? 'Network error' :
            targetSsrf.kind === 'timeout' ? 'SSRF timeout' : 'SSRF blocked';
          return {
            status,
            contentType,
            finalUrl: logicalUrl,
            redirectChain,
            body: null,
            error: `${errorPrefix} redirect: ${targetSsrf.reason}`,
            aborted: false,
            retryAfter,
            bodyError: false,
            failureReason,
          };
        }

        logicalUrl = nextUrl;
        redirectChain.push(logicalUrl);

        const nextServername = new URL(nextUrl).hostname;
        if (targetSsrf.ip && (targetSsrf.ip !== validatedIp || nextServername !== servername)) {
          validatedIp = targetSsrf.ip;
          servername = nextServername;
          dispatcher = createPinnedAgent({ validatedIp, servername, ...(cfg.ca ? { ca: cfg.ca } : {}) });
          cleanupAgents.push(dispatcher);
        }

        await drainBody(response, attemptController!);
        if (attemptTimer) clearTimeout(attemptTimer);
        continue;
      }

      const bodyResult = await readBody(response, cfg.maxBytes, attemptController!);
      if (attemptTimer) clearTimeout(attemptTimer);

      return {
        status,
        contentType,
        finalUrl: logicalUrl,
        redirectChain,
        body: bodyResult.content,
        error: bodyResult.error,
        aborted: bodyResult.aborted,
        retryAfter,
        bodyError: bodyResult.bodyError,
        failureReason: bodyResult.failureReason,
      };
    }

    return {
      status: 0,
      contentType: null,
      finalUrl: logicalUrl,
      redirectChain,
      body: null,
      error: `Too many redirects (max ${cfg.maxRedirects})`,
      aborted: false,
      retryAfter: null,
      bodyError: false,
      failureReason: 'too_many_redirects',
    };
  } finally {
    await Promise.allSettled(cleanupAgents.map((a) => a.close()));
  }
}

export type IpPolicy = (ip: string) => boolean;

export const defaultIpPolicy: IpPolicy = isPrivateIp;

export async function checkUrlAllowed(
  url: string,
  dnsResolver?: DnsResolver,
  ipPolicy: IpPolicy = defaultIpPolicy,
): Promise<SsrfCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'Invalid URL', kind: 'error' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: `Disallowed scheme: ${parsed.protocol}`, kind: 'blocked' };
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    return { allowed: false, reason: 'Missing hostname', kind: 'error' };
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { allowed: false, reason: 'Blocked hostname: localhost', ip: '127.0.0.1', kind: 'blocked' };
  }

  const { isIP: netIsIP } = await import('node:net');
  const ipRegex = /^\[?([0-9a-fA-F:.]+)\]?$/;
  const ipMatch = hostname.match(ipRegex);
  if (ipMatch && netIsIP(ipMatch[1]!) !== 0) {
    const ip = ipMatch[1]!;
    return ipPolicy(ip)
      ? { allowed: false, reason: `Blocked IP: ${ip}`, ip, kind: 'blocked' }
      : { allowed: true, ip, kind: 'ok' };
  }

  try {
    const resolver = dnsResolver ?? ((h: string) => lookupWithTimeout(h, DNS_TIMEOUT_MS));
    const addresses = await withTimeout(resolver(hostname), DNS_TIMEOUT_MS, `DNS resolution timeout after ${DNS_TIMEOUT_MS}ms`);
    const blocked = addresses.find((a) => ipPolicy(a.address));
    if (blocked) {
      return { allowed: false, reason: `Blocked IP: ${blocked.address}`, ip: blocked.address, kind: 'blocked' };
    }
    if (addresses.length === 0) {
      return { allowed: false, reason: 'No addresses resolved', kind: 'error' };
    }
    const first = addresses[0]!;
    return {
      allowed: true,
      ip: first.address,
      kind: 'ok',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = message.includes('DNS resolution timeout') || message.includes('timeout');
    return {
      allowed: false,
      reason: `DNS resolution failed: ${message}`,
      kind: isTimeout ? 'timeout' : 'error',
    };
  }
}

const DNS_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function lookupWithTimeout(
  hostname: string,
  timeoutMs: number,
): Promise<Array<{ address: string; family: number }>> {
  const { lookup } = await import('node:dns/promises');
  return withTimeout(lookup(hostname, { all: true }), timeoutMs, `DNS resolution timeout after ${timeoutMs}ms`);
}
