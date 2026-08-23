import { checkUrlAllowed } from './ssrf.js';

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

export async function boundedFetch(
  url: string,
  config: Partial<FetcherConfig> = {},
): Promise<FetchResult> {
  const cfg = { ...DEFAULT_FETCHER_CONFIG, ...config };
  const ssrfCheck = cfg.ssrfChecker ?? checkUrlAllowed;
  const redirectChain: string[] = [];
  let currentUrl = url;
  let retryCount = 0;

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
    };
  }

  for (let redirect = 0; redirect <= cfg.maxRedirects; redirect++) {
    const domain = getDomain(currentUrl);
    if (domain) {
      await applyDomainDelay(domain, cfg);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method: 'GET',
        headers: {
          'User-Agent': cfg.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 0,
        contentType: null,
        finalUrl: currentUrl,
        redirectChain,
        body: null,
        error: message,
        aborted: message.includes('abort'),
        retryAfter: null,
        bodyError: false,
      };
    }
    clearTimeout(timeout);

    const { status } = response;
    const contentType = response.headers.get('content-type');
    const retryAfter = cfg.respectRetryAfter ? response.headers.get('retry-after') : null;

    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return {
          status,
          contentType,
          finalUrl: currentUrl,
          redirectChain,
          body: null,
          error: 'Redirect without Location header',
          aborted: false,
          retryAfter,
          bodyError: false,
        };
      }

      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).href;
      } catch {
        return {
          status,
          contentType,
          finalUrl: currentUrl,
          redirectChain,
          body: null,
          error: `Invalid redirect URL: ${location}`,
          aborted: false,
          retryAfter,
          bodyError: false,
        };
      }

      const targetSsrf = await ssrfCheck(nextUrl);
      if (!targetSsrf.allowed) {
        return {
          status,
          contentType,
          finalUrl: currentUrl,
          redirectChain,
          body: null,
          error: `SSRF blocked redirect: ${targetSsrf.reason}`,
          aborted: false,
          retryAfter,
          bodyError: false,
        };
      }

      redirectChain.push(currentUrl);
      currentUrl = nextUrl;
      continue;
    }

    if (status === 429 || (status === 503 && retryAfter)) {
      if (retryCount < cfg.maxRetries) {
        const delayMs = parseRetryAfter(retryAfter) ?? (cfg.baseRetryDelayMs * (retryCount + 1));
        retryCount++;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      return {
        status,
        contentType,
        finalUrl: currentUrl,
        redirectChain,
        body: null,
        error: `Rate limited: ${status}`,
        aborted: false,
        retryAfter,
        bodyError: false,
      };
    }

    const bodyResult = await readBody(response, cfg.maxBytes);

    return {
      status,
      contentType,
      finalUrl: currentUrl,
      redirectChain,
      body: bodyResult.content,
      error: bodyResult.error,
      aborted: bodyResult.aborted,
      retryAfter,
      bodyError: bodyResult.bodyError,
    };
  }

  return {
    status: 0,
    contentType: null,
    finalUrl: currentUrl,
    redirectChain,
    body: null,
    error: `Too many redirects (max ${cfg.maxRedirects})`,
    aborted: false,
    retryAfter: null,
    bodyError: false,
  };
}

type BodyResult = {
  content: string | null;
  error: string | null;
  aborted: boolean;
  bodyError: boolean;
};

async function readBody(response: Response, maxBytes: number): Promise<BodyResult> {
  if (!response.body) {
    try {
      const text = await response.text();
      if (text.length > maxBytes) {
        return { content: null, error: `Body exceeded ${maxBytes} bytes`, aborted: true, bodyError: true };
      }
      return { content: text, error: null, aborted: false, bodyError: false };
    } catch (error) {
      return { content: null, error: `Failed to read response body: ${error instanceof Error ? error.message : String(error)}`, aborted: false, bodyError: true };
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let totalBytes = 0;
  let result = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return { content: null, error: `Body exceeded ${maxBytes} bytes`, aborted: true, bodyError: true };
      }

      result += decoder.decode(value, { stream: true });
    }

    result += decoder.decode();
    return { content: result, error: null, aborted: false, bodyError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: null, error: message, aborted: message.includes('abort'), bodyError: true };
  }
}
