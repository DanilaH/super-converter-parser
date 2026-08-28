import { getDomain } from 'tldts';

const DOMAIN_OPTIONS = {
  // For SEO research, private PSL boundaries represent independent sites too.
  // Example: foo.github.io and bar.github.io must not collapse to github.io.
  allowPrivateDomains: true,
  // Callers already pass URL.hostname. Disabling extraction keeps this helper
  // hostname-only instead of letting tldts reinterpret URLs/emails/host:port.
  extractHostname: false,
} as const;

export function registrableDomain(hostname: string): string | null {
  if (!hostname) return null;

  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  if (/[\s/:@?#]/.test(host)) return null;

  return getDomain(host, DOMAIN_OPTIONS);
}
