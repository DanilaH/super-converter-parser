import { lookup } from 'node:dns/promises';

const PRIVATE_IPV4_RANGES = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
];

const RESERVED_IPV6_PREFIXES = [
  'fc', 'fd',
  'fe80:', 'fec:', 'fee:', 'fef:',
  'ff',
  '::', '::1',
  '2001:db8:',
  '64:ff9b:',
  '2001:10:', '2001:20:',
];

const METADATA_IPS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  'fd00:ec2::254',
  '100.100.100.200',
]);

export function isPrivateIp(ip: string): boolean {
  if (METADATA_IPS.has(ip)) return true;

  const lower = ip.toLowerCase();

  if (lower.includes(':')) {
    if (lower.startsWith('::ffff:')) {
      const ipv4Part = lower.slice(7);
      if (ipv4Part.includes('.')) {
        return PRIVATE_IPV4_RANGES.some((re) => re.test(ipv4Part));
      }
      if (ipv4Part.includes(':')) {
        const hexGroups = ipv4Part.split(':');
        if (hexGroups.length === 2) {
          const high = parseInt(hexGroups[0]!, 16);
          const low = parseInt(hexGroups[1]!, 16);
          if (!Number.isNaN(high) && !Number.isNaN(low)) {
            const ip = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
            return PRIVATE_IPV4_RANGES.some((re) => re.test(ip));
          }
        }
      }
      return false;
    }
    if (RESERVED_IPV6_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
    return false;
  }

  return PRIVATE_IPV4_RANGES.some((re) => re.test(lower));
}

export type SsrfCheckResult = {
  allowed: boolean;
  reason?: string;
  ip?: string;
  ips?: string[];
};

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

export async function checkUrlAllowed(url: string): Promise<SsrfCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'Invalid URL' };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
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
      : { allowed: true, ip, ips: [ip] };
  }

  try {
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
      ips: addresses.map((a) => a.address),
    };
  } catch (error) {
    return { allowed: false, reason: `DNS resolution failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function buildPinnedUrl(originalUrl: string, validatedIp: string): string {
  try {
    const parsed = new URL(originalUrl);
    const isIpv6 = validatedIp.includes(':');
    const hostForUrl = isIpv6 ? `[${validatedIp}]` : validatedIp;
    parsed.hostname = hostForUrl;
    return parsed.href;
  } catch {
    return originalUrl;
  }
}

export function getValidatedHostHeader(originalUrl: string): string {
  try {
    const parsed = new URL(originalUrl);
    return parsed.host;
  } catch {
    return '';
  }
}
