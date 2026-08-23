import { Agent } from 'undici';
import { isPrivateIp } from './ssrf.js';

export type SsrfChecker = (url: string) => Promise<{ allowed: boolean; reason?: string; ip?: string }>;

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

class PinnedAgent extends Agent {
  constructor(validatedIp: string, servername: string, opts: Agent.Options = {}) {
    super({
      ...opts,
      connect: {
        host: validatedIp,
        servername,
      },
    });
  }
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
      const isTimeout = message.includes('abort');
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
    const isTimeout = message.includes('abort');
    return {
      content: null,
      error: message,
      aborted: isTimeout,
      bodyError: true,
      failureReason: isTimeout ? 'timeout' : 'read_error',
    };
  }
}

export async function boundedFetch(
  url: string,
  config: Partial<FetcherConfig> = {},
): Promise<FetchResult> {
  const cfg = { ...DEFAULT_FETCHER_CONFIG, ...config };
  const ssrfCheck = cfg.ssrfChecker ?? checkUrlAllowed;
  const redirectChain: string[] = [];
  let logicalUrl = url;
  let retryCount = 0;
  let retryRedirectBudget = 0;

  const ssrfResult = await ssrfCheck(url);
  if (!ssrfResult.allowed) {
    return {
      status: 0,
      contentType: null,
      finalUrl: url,
      redirectChain: [],
      body: null,
      error: `SSRF blocked: ${ssrfResult.reason}`,
      aborted: false,
      retryAfter: null,
      bodyError: false,
      failureReason: 'blocked',
    };
  }

  let validatedIp: string | undefined = ssrfResult.ip;
  let dispatcher: PinnedAgent | undefined;
  if (validatedIp) {
    dispatcher = new PinnedAgent(validatedIp, new URL(url).hostname);
  }

  for (let redirect = 0; redirect <= cfg.maxRedirects; redirect++) {
    const domain = getDomain(logicalUrl);
    if (domain) {
      await applyDomainDelay(domain, cfg);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);

    let response: Response;
    try {
      response = await fetch(logicalUrl, {
        method: 'GET',
        headers: {
          'User-Agent': cfg.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        redirect: 'manual',
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (error) {
      clearTimeout(timeout);
      const message = error instanceof Error ? error.message : String(error);
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
    const retryAfter = cfg.respectRetryAfter ? response.headers.get('retry-after') : null;

    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        clearTimeout(timeout);
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
        clearTimeout(timeout);
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
        clearTimeout(timeout);
        return {
          status,
          contentType,
          finalUrl: logicalUrl,
          redirectChain,
          body: null,
          error: `SSRF blocked redirect: ${targetSsrf.reason}`,
          aborted: false,
          retryAfter,
          bodyError: false,
          failureReason: 'blocked',
        };
      }

      clearTimeout(timeout);
      logicalUrl = nextUrl;
      redirectChain.push(logicalUrl);
      if (targetSsrf.ip && targetSsrf.ip !== validatedIp) {
        validatedIp = targetSsrf.ip;
        dispatcher = new PinnedAgent(validatedIp, new URL(nextUrl).hostname);
      }
      continue;
    }

    if (status === 429 || (status === 503 && retryAfter)) {
      clearTimeout(timeout);
      if (retryCount < cfg.maxRetries && retryRedirectBudget < cfg.maxRedirects) {
        const delayMs = parseRetryAfter(retryAfter) ?? (cfg.baseRetryDelayMs * (retryCount + 1));
        retryCount++;
        retryRedirectBudget++;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
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

    const bodyResult = await readBody(response, cfg.maxBytes, controller);

    clearTimeout(timeout);

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
}

export async function checkUrlAllowed(url: string): Promise<{ allowed: boolean; reason?: string; ip?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'Invalid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: `Disallowed scheme: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    return { allowed: false, reason: 'Missing hostname' };
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { allowed: false, reason: 'Blocked hostname: localhost', ip: '127.0.0.1' };
  }

  const ipRegex = /^\[?([0-9a-fA-F:.]+)\]?$/;
  const ipMatch = hostname.match(ipRegex);
  if (ipMatch) {
    const ip = ipMatch[1]!;
    return isPrivateIp(ip)
      ? { allowed: false, reason: `Blocked IP: ${ip}`, ip }
      : { allowed: true, ip };
  }

  try {
    const { lookup } = await import('node:dns/promises');
    const addresses = await lookup(hostname, { all: true });
    const blocked = addresses.find((a) => isPrivateIp(a.address));
    if (blocked) {
      return { allowed: false, reason: `Blocked IP: ${blocked.address}`, ip: blocked.address };
    }
    if (addresses.length === 0) {
      return { allowed: false, reason: 'No addresses resolved' };
    }
    const first = addresses[0]!;
    return {
      allowed: true,
      ip: first.address,
    };
  } catch (error) {
    return { allowed: false, reason: `DNS resolution failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
