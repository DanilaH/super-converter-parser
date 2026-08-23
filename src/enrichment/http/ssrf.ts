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
  { net: ipv4ToInt('250.0.0.0'), mask: 0xf8000000 },
];

function computeMask6(prefixLen: number): bigint {
  if (prefixLen <= 0) return BigInt(0);
  if (prefixLen >= 128) return (BigInt(1) << BigInt(128)) - BigInt(1);
  return ((BigInt(1) << BigInt(prefixLen)) - BigInt(1)) << BigInt(128 - prefixLen);
}

interface Cidr6 {
  net: bigint;
  prefixLen: number;
}

const PRIVATE_CIDRS_V6: Cidr6[] = [
  { net: ipv6ToBigInt('::1'), prefixLen: 128 },
  { net: ipv6ToBigInt('::'), prefixLen: 128 },
  { net: ipv6ToBigInt('::ffff:0:0'), prefixLen: 96 },
  { net: ipv6ToBigInt('64:ff9b::'), prefixLen: 96 },
  { net: ipv6ToBigInt('64:ff9b:1::'), prefixLen: 48 },
  { net: ipv6ToBigInt('100::'), prefixLen: 64 },
  { net: ipv6ToBigInt('2001::'), prefixLen: 32 },
  { net: ipv6ToBigInt('2001:10::'), prefixLen: 28 },
  { net: ipv6ToBigInt('2001:db8::'), prefixLen: 32 },
  { net: ipv6ToBigInt('2002::'), prefixLen: 16 },
  { net: ipv6ToBigInt('fc00::'), prefixLen: 7 },
  { net: ipv6ToBigInt('fe80::'), prefixLen: 10 },
  { net: ipv6ToBigInt('fec0::'), prefixLen: 10 },
  { net: ipv6ToBigInt('ff00::'), prefixLen: 8 },
  { net: ipv6ToBigInt('3ffe::'), prefixLen: 16 },
  { net: ipv6ToBigInt('5f00::'), prefixLen: 8 },
  { net: ipv6ToBigInt('2001:0000::'), prefixLen: 32 },
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

function ipv6ToBigInt(ip: string): bigint {
  const parts = ip.split('::');
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];

  const missing = 8 - left.length - right.length;
  const allParts = [...left, ...Array(missing).fill('0'), ...right];

  let result = BigInt(0);
  for (let i = 0; i < 8; i++) {
    const part = parseInt(allParts[i] || '0', 16);
    result = (result << BigInt(16)) | BigInt(part);
  }
  return result;
}

function isIpv6InCidr(ip: string): boolean {
  if (isIP(ip) !== 6) return false;

  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const ipv4Part = lower.split('::ffff:')[1];
    if (ipv4Part && isIP(ipv4Part) === 4) {
      return isIpv4InCidr(ipv4Part);
    }
  }

  const ipBig = ipv6ToBigInt(ip);
  return PRIVATE_CIDRS_V6.some(({ net, prefixLen }) => {
    const mask = computeMask6(prefixLen);
    return (ipBig & mask) === (net & mask);
  });
}

export function isPrivateIp(ip: string): boolean {
  if (METADATA_IPS.has(ip)) return true;

  if (isIP(ip) === 4) {
    return isIpv4InCidr(ip);
  }

  if (isIP(ip) === 6) {
    return isIpv6InCidr(ip);
  }

  return false;
}

export type SsrfCheckResult = {
  allowed: boolean;
  reason?: string;
  ip?: string;
};
