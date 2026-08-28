import { getDomain } from 'tldts';

const DOMAIN_OPTIONS = {
  // For SEO research, private PSL boundaries represent independent sites too.
  // Example: foo.github.io and bar.github.io must not collapse to github.io.
  allowPrivateDomains: true,
  // Callers already pass URL.hostname. Disable tldts URL/email extraction too;
  // the explicit delimiter guard below is what enforces the hostname-only contract.
  extractHostname: false,
} as const;

export function registrableDomain(hostname: string): string | null {
  if (!hostname) return null;

  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  if (/[\s/:@?#]/.test(host)) return null;

  return getDomain(host, DOMAIN_OPTIONS);
}
