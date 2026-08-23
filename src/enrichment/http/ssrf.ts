const PRIVATE_IPV4_RANGES = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
  /^192\.0\.[02]\./,
  /^198\.51\.100\./,
  /^203\.0\.113\./,
  /^198\.1[89]\./,
  /^22[4-9]\./,
  /^23[0-9]\./,
  /^24[0-9]\./,
  /^255\./,
];

const RESERVED_IPV6_PREFIXES = [
  'fc', 'fd',
  'fe80:', 'fec:', 'fee:', 'fef:',
  'ff',
  '::', '::1',
  '2001:db8:',
  '64:ff9b:',
  '2001:10:', '2001:20:',
  '2001::', '2002::',
  'fec0:', '3ffe::',
  '5f00::',
  '2001:0010::',
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
};
