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

interface Cidr6 {
  net: bigint;
  mask: bigint;
  prefixLen: number;
}

const PRIVATE_CIDRS_V6: Cidr6[] = [
  { net: ipv6ToBigInt('::1'), mask: BigInt('0xffffffffffffffffffffffffffffffff'), prefixLen: 128 },
  { net: ipv6ToBigInt('::'), mask: BigInt('0xffffffffffffffffffffffffffffffff'), prefixLen: 128 },
  { net: ipv6ToBigInt('::ffff:0:0'), mask: BigInt('0xffffffffffffffffffffffff00000000'), prefixLen: 96 },
  { net: ipv6ToBigInt('64:ff9b::'), mask: BigInt('0xffffffffffffffff0000000000000000'), prefixLen: 96 },
  { net: ipv6ToBigInt('64:ff9b:1::'), mask: BigInt('0xfffffffffffffffe0000000000000000'), prefixLen: 48 },
  { net: ipv6ToBigInt('100::'), mask: BigInt('0xffffffffffffffffffffffff00000000'), prefixLen: 64 },
  { net: ipv6ToBigInt('2001::'), mask: BigInt('0xffffffffffff00000000000000000000'), prefixLen: 32 },
  { net: ipv6ToBigInt('2001:10::'), mask: BigInt('0xffffffffffff00000000000000000000'), prefixLen: 28 },
  { net: ipv6ToBigInt('2001:db8::'), mask: BigInt('0xffffffffffff00000000000000000000'), prefixLen: 32 },
  { net: ipv6ToBigInt('2002::'), mask: BigInt('0xffffffff000000000000000000000000'), prefixLen: 16 },
  { net: ipv6ToBigInt('fc00::'), mask: BigInt('0xfe000000000000000000000000000000'), prefixLen: 7 },
  { net: ipv6ToBigInt('fe80::'), mask: BigInt('0xffc00000000000000000000000000000'), prefixLen: 10 },
  { net: ipv6ToBigInt('fec0::'), mask: BigInt('0xffc00000000000000000000000000000'), prefixLen: 10 },
  { net: ipv6ToBigInt('ff00::'), mask: BigInt('0xff000000000000000000000000000000'), prefixLen: 8 },
  { net: ipv6ToBigInt('3ffe::'), mask: BigInt('0xffffffff000000000000000000000000'), prefixLen: 16 },
  { net: ipv6ToBigInt('5f00::'), mask: BigInt('0xff000000000000000000000000000000'), prefixLen: 8 },
  { net: ipv6ToBigInt('2001:0000::'), mask: BigInt('0xffffffffffff00000000000000000000'), prefixLen: 32 },
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

  if (ip.toLowerCase().startsWith('::ffff:')) {
    const ipv4Part = ip.split('::ffff:')[1];
    if (ipv4Part && isIP(ipv4Part) === 4) {
      return isIpv4InCidr(ipv4Part);
    }
  }

  const ipBig = ipv6ToBigInt(ip);
  return PRIVATE_CIDRS_V6.some(({ net, mask }) => (ipBig & mask) === (net & mask));
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
