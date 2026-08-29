export const CLUSTER_URL_IDENTITY_VERSION = '1.0.0';

const TRACKING_PARAMS = new Set([
  'dclid',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'msclkid',
  'srsltid',
]);

function isTrackingParam(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.startsWith('utm_') || TRACKING_PARAMS.has(normalized);
}

/**
 * Builds the comparison identity used by clustering v2 while leaving the raw
 * ranking URL untouched in source evidence.
 *
 * Deliberately normalized:
 * - http/https scheme (not part of the key)
 * - hostname case and a leading `www.`
 * - fragment
 * - trailing slash on non-root paths
 * - known tracking-only query parameters
 * - query parameter ordering
 *
 * Deliberately preserved:
 * - non-www subdomains
 * - path case/content
 * - semantic query parameters (for example YouTube `?v=`)
 */
export function clusteringUrlIdentity(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  const port = parsed.port;

  let path = parsed.pathname || '/';
  if (path.length > 1) path = path.replace(/\/+$/, '');

  const params: Array<[string, string]> = [];
  for (const [name, value] of parsed.searchParams.entries()) {
    if (isTrackingParam(name)) continue;
    params.push([name, value]);
  }
  params.sort(([nameA, valueA], [nameB, valueB]) =>
    nameA.localeCompare(nameB) || valueA.localeCompare(valueB),
  );

  const query = new URLSearchParams();
  for (const [name, value] of params) query.append(name, value);
  const queryString = query.toString();

  return `${host}${port ? `:${port}` : ''}${path}${queryString ? `?${queryString}` : ''}`;
}
