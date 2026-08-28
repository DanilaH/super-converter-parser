import { getDomain } from 'tldts';

const DOMAIN_OPTIONS = {
  // For SEO research, private PSL boundaries represent independent sites too.
  // Example: foo.github.io and bar.github.io must not collapse to github.io.
  allowPrivateDomains: true,
} as const;

export function registrableDomain(hostname: string): string | null {
  if (!hostname) return null;

  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return null;

  // Callers pass URL.hostname values. Keep this helper hostname-only instead of
  // accepting tldts' broader URL/email input forms by accident.
  if (/[\s/@?#]/.test(host)) return null;

  return getDomain(host, DOMAIN_OPTIONS);
}
