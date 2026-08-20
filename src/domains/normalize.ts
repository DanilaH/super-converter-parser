// Lightweight registrable-domain extraction without a Public Suffix List
// dependency. Covers the overwhelming majority of SEO domains via a small
// multi-part TLD allowlist plus the default two-label rule. IP literals and
// bare hosts are rejected.

const MULTI_PART_TLDS = new Set<string>([
  'co.uk', 'org.uk', 'me.uk', 'gov.uk', 'ac.uk',
  'com.au', 'net.au', 'org.au', 'edu.au',
  'co.nz', 'geek.nz', 'school.nz',
  'co.jp', 'or.jp', 'ne.jp',
  'com.br', 'com.mx', 'com.ar', 'com.pe', 'com.co', 'com.ve', 'com.ec',
  'com.tr', 'com.sg', 'com.cn', 'com.kr', 'com.tw', 'com.hk', 'com.id',
  'com.za', 'co.za', 'com.ng', 'com.pk', 'com.ph', 'com.my', 'com.th',
  'co.in', 'com.sa', 'com.eg', 'com.uy', 'com.py', 'com.bo', 'com.do',
  'com.gt', 'com.sv', 'com.ni', 'com.cr', 'com.pa', 'com.pr', 'com.cl',
  'com.ua', 'com.vn', 'com.bd', 'com.lb', 'com.iq', 'com.kw', 'com.il',
]);

export function registrableDomain(hostname: string): string | null {
  if (!hostname) return null;
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return null;

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  if (host.includes(':')) return null;

  const labels = host.split('.');
  if (labels.length < 2) return null;

  if (labels.length >= 3) {
    const lastTwo = labels.slice(-2).join('.');
    if (MULTI_PART_TLDS.has(lastTwo)) {
      return labels.slice(-3).join('.');
    }
  }

  return labels.slice(-2).join('.');
}
