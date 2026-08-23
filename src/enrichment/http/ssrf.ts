import { isIP } from 'node:net';

const METADATA_IPS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  'fd00:ec2::254',
  '100.100.100.200',
]);

interface Cidr4 {
  net: number;
  mask: number;
}

const PRIVATE_CIDRS: Cidr4[] = [
  { net: ipv4ToInt('10.0.0.0'), mask: 0xff000000 },
  { net: ipv4ToInt('127.0.0.0'), mask: 0xff000000 },
  { net: ipv4ToInt('169.254.0.0'), mask: 0xffff0000 },
  { net: ipv4ToInt('172.16.0.0'), mask: 0xfff00000 },
  { net: ipv4ToInt('192.168.0.0'), mask: 0xffff0000 },
  { net: ipv4ToInt('0.0.0.0'), mask: 0xff000000 },
  { net: ipv4ToInt('100.64.0.0'), mask: 0xffc00000 },
  { net: ipv4ToInt('192.0.2.0'), mask: 0xffffff00 },
  { net: ipv4ToInt('198.51.100.0'), mask: 0xffffff00 },
  { net: ipv4ToInt('203.0.113.0'), mask: 0xffffff00 },
  { net: ipv4ToInt('198.18.0.0'), mask: 0xfffe0000 },
  { net: ipv4ToInt('198.19.0.0'), mask: 0xfffe0000 },
  { net: ipv4ToInt('192.0.0.0'), mask: 0xffffff00 },
  { net: ipv4ToInt('240.0.0.0'), mask: 0xf0000000 },
  { net: ipv4ToInt('255.255.255.255'), mask: 0xffffffff },
  { net: ipv4ToInt('224.0.0.0'), mask: 0xf0000000 },
  { net: ipv4ToInt('127.0.0.0'), mask: 0xff000000 },
  { net: ipv4ToInt('127.255.255.255'), mask: 0xffffffff },
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
  '::ffff:0:0',
  '64:ff9b:1::',
  '2001:0010::',
  '2001:0000::',
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.');
  return ((parseInt(parts[0]!, 10) << 24) |
    (parseInt(parts[1]!, 10) << 16) |
    (parseInt(parts[2]!, 10) << 8) |
    parseInt(parts[3]!, 10)) >>> 0;
}

function isIpv4InCidr(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const ipInt = ipv4ToInt(ip);
  return PRIVATE_CIDRS.some(({ net, mask }) => (ipInt & mask) === (net & mask));
}

function canonicalizeIpv6(ip: string): string {
  try {
    const { toBigInt } = require('node:ip');
    return toBigInt ? toBigInt(ip).toString(16) : ip.toLowerCase();
  } catch {
    return ip.toLowerCase();
  }
}

function isReservedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  if (lower.startsWith('::ffff:')) {
    const ipv4Part = lower.slice(7);
    if (ipv4Part.includes('.')) {
      return isIpv4InCidr(ipv4Part);
    }
    if (ipv4Part.includes(':')) {
      const hexGroups = ipv4Part.split(':');
      if (hexGroups.length === 2) {
        const high = parseInt(hexGroups[0]!, 16);
        const low = parseInt(hexGroups[1]!, 16);
        if (!Number.isNaN(high) && !Number.isNaN(low)) {
          const ip = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
          return isIpv4InCidr(ip);
        }
      }
    }
    return false;
  }

  if (RESERVED_IPV6_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;

  return false;
}

export function isPrivateIp(ip: string): boolean {
  if (METADATA_IPS.has(ip)) return true;

  if (isIP(ip) === 4) {
    return isIpv4InCidr(ip);
  }

  if (isIP(ip) === 6) {
    return isReservedIpv6(ip);
  }

  return false;
}

export type SsrfCheckResult = {
  allowed: boolean;
  reason?: string;
  ip?: string;
};
