// IANA RDAP bootstrap service discovery (RFC 9224).
//
// The registry publishes a JSON file at <bootstrapBase>/<bootstrapFile> (default
// https://data.iana.org/rdap/dns.json). Its `services` array maps groups of TLDs
// to one or more RDAP base URLs. A client does a label-wise longest-suffix match
// to find the authoritative base URL(s) for a domain, e.g. `example.co.uk` ->
// `co.uk` -> Verisign/ Nominet-hosted servers (varies by TLD).
import { domainToASCII } from 'node:url';
import type { RdapClientConfig } from './types.js';

export type BootstrapFile = {
  version: string;
  publication: string;
  description?: string;
  services: Array<[Array<string>, Array<string>]>;
};

// Resolve a domain to its RDAP base URLs via a cached in-memory copy of the
// IANA bootstrap file. The file is re-fetched once `bootstrapTtlMs` elapse.
// Injectable `fetchImpl` and `now` make this deterministic in tests.
export class RdapBootstrapResolver {
  private readonly config: RdapClientConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private index: Map<string, string[]> | null = null;
  private expiresAt: number = 0;

  constructor(config: RdapClientConfig, fetchImpl: typeof fetch, now: () => number) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async resolveBaseUrls(domain: string): Promise<string[] | null> {
    const index = await this.getIndex();
    return lookupRdapBaseUrls(domain, index);
  }

  private async getIndex(): Promise<Map<string, string[]>> {
    const now = this.now();
    if (this.index !== null && now < this.expiresAt) {
      return this.index;
    }
    const data = await this.fetchBootstrap();
    this.index = buildTldIndex(data);
    this.expiresAt = now + this.config.bootstrapTtlMs;
    return this.index;
  }

  private async fetchBootstrap(): Promise<BootstrapFile> {
    const url = `${this.config.bootstrapBase}${this.config.bootstrapFile}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.queryTimeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`RDAP bootstrap fetch failed with HTTP ${res.status}`);
      }
      // Cast is safe: the caller validates shape before use; a malformed body
      // surfaces as a structured 'error' result in the client.
      return (await res.json()) as BootstrapFile;
    } finally {
      clearTimeout(timer);
    }
  }

  // Exposed for tests that want to seed the index without hitting the network.
  setIndex(index: Map<string, string[]>): void {
    this.index = index;
    this.expiresAt = Number.POSITIVE_INFINITY;
  }
}

// Build a Map<lowercase-ascii-tld, baseUrls[]> from the bootstrap services array.
export function buildTldIndex(bootstrap: BootstrapFile): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [tlds, baseUrls] of bootstrap.services) {
    if (!Array.isArray(tlds) || !Array.isArray(baseUrls)) continue;
    for (const tld of tlds) {
      const key = String(tld).toLowerCase();
      const existing = index.get(key);
      if (!existing) {
        index.set(key, [...baseUrls]);
      } else {
        for (const url of baseUrls) {
          if (!existing.includes(url)) existing.push(url);
        }
      }
    }
  }
  return index;
}

// Longest-suffix match per RFC 9224 §4. Candidate suffixes are generated from
// longest to shortest; the first TLD present in the index wins. IDN TLDs are
// converted to ASCII (Punycode) via domainToASCII before matching, since the
// bootstrap stores IDN TLDs as `xn--` A-Labels.
export function lookupRdapBaseUrls(
  domain: string,
  index: Map<string, string[]>,
): string[] | null {
  const host = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return null;
  }
  const labels = host.split('.');
  if (labels.length < 2) return null;

  // Longest-suffix match per RFC 9224 §4. Candidate suffixes run from the full
  // host down to the bare TLD, so the TLD itself (the last label, i.e.
  // start === labels.length - 1) is always considered.
  for (let start = 0; start < labels.length; start += 1) {
    const suffix = labels.slice(start).join('.');
    if (index.has(suffix)) return index.get(suffix) as string[];
    const ascii = toAsciiTld(suffix);
    if (ascii && ascii !== suffix && index.has(ascii)) {
      return index.get(ascii) as string[];
    }
  }
  return null;
}

function toAsciiTld(tld: string): string {
  try {
    return domainToASCII(tld).toLowerCase();
  } catch {
    return tld;
  }
}

function hostOf(urlString: string): string {
  try {
    return new URL(urlString).host;
  } catch {
    return urlString;
  }
}
export { hostOf };
