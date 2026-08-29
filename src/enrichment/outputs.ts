import { writeTextAtomic } from '../runs/run.js';
import { renderCsv } from '../exports/csv.js';
import type { ClusteringConfig, KeywordCluster, PairwiseComparison, ClusteredKeywordExclusion } from './types.js';
import type { PageRecord } from './pages/types.js';
import type { SiteStructureRecord } from './site_structure/types.js';

export type ClusterOutputOptions = {
  enrichmentId: string;
  sourceRunId: string;
  outputDirectory: string;
  clusters: KeywordCluster[];
  pairs: PairwiseComparison[];
  exclusions: ClusteredKeywordExclusion[];
  edgeCount: number;
  inputCount: number;
  excludedCount: number;
  algorithmVersion: string;
  config: ClusteringConfig;
};

export function writeKeywordClustersCsv(outputPath: string, clusters: KeywordCluster[]): Promise<void> {
  const header = [
    'cluster_id',
    'canonical_keyword_idx',
    'canonical_keyword',
    'member_count',
    'member_keyword_idxs',
    'members',
    'median_volume',
    'average_volume',
    'representative_domains',
  ];
  const rows: string[][] = [header];
  for (const cluster of clusters) {
    rows.push([
      cluster.clusterId,
      cluster.canonicalKeywordIdx === null ? '' : String(cluster.canonicalKeywordIdx),
      cluster.canonicalKeyword,
      String(cluster.memberCount),
      cluster.members.map((m) => m.keywordIdx === null ? '' : String(m.keywordIdx)).join('; '),
      cluster.members.map((m) => m.keyword).join('; '),
      cluster.medianVolume !== null ? String(cluster.medianVolume) : '',
      cluster.averageVolume !== null ? cluster.averageVolume.toFixed(2) : '',
      cluster.representativeDomains.join('; '),
    ]);
  }
  return writeFileAtomic(outputPath, renderCsv(rows), 'keyword-clusters.csv');
}

export function writeKeywordClustersJson(
  outputPath: string,
  options: ClusterOutputOptions,
): Promise<void> {
  const payload = {
    enrichmentId: options.enrichmentId,
    sourceRunId: options.sourceRunId,
    algorithmVersion: options.algorithmVersion,
    generatedAt: new Date().toISOString(),
    config: options.config,
    inputCount: options.inputCount,
    excludedCount: options.excludedCount,
    edgeCount: options.edgeCount,
    clusterCount: options.clusters.length,
    clusters: options.clusters.map((c) => ({
      clusterId: c.clusterId,
      canonicalKeywordIdx: c.canonicalKeywordIdx,
      canonicalKeyword: c.canonicalKeyword,
      memberCount: c.memberCount,
      members: c.members,
      medianVolume: c.medianVolume,
      averageVolume: c.averageVolume,
      representativeDomains: c.representativeDomains,
    })),
    pairs: options.pairs,
    exclusions: options.exclusions,
  };
  return writeFileAtomic(outputPath, JSON.stringify(payload, null, 2) + '\n', 'keyword-clusters.json');
}

export function writePagesCsv(outputPath: string, pages: PageRecord[]): Promise<void> {
  const header = [
    'url',
    'final_url',
    'redirect_count',
    'http_status',
    'content_type',
    'fetch_status',
    'fetch_error',
    'title',
    'meta_description',
    'h1',
    'canonical',
    'language',
    'word_count',
    'possibly_js_rendered',
    'form_count',
    'textarea_count',
    'input_count',
    'file_input_count',
    'button_count',
    'structured_data_types',
    'cache_status',
    'fetched_at',
    'source_keywords',
    'source_positions',
  ];
  const rows: string[][] = [header];
  for (const page of pages) {
    rows.push([
      page.url,
      page.finalUrl,
      String(page.redirectCount),
      String(page.httpStatus),
      page.contentType ?? '',
      page.fetchStatus,
      page.fetchError ?? '',
      page.title ?? '',
      page.metaDescription ?? '',
      page.h1 ?? '',
      page.canonical ?? '',
      page.language ?? '',
      page.wordCount !== null ? String(page.wordCount) : '',
      String(page.possiblyJsRendered),
      String(page.forms.formCount),
      String(page.forms.textareaCount),
      String(page.forms.inputCount),
      String(page.forms.fileInputCount),
      String(page.forms.buttonCount),
      page.structuredDataTypes.join('; '),
      page.cacheStatus,
      page.fetchedAt,
      page.sourceKeywords.join('; '),
      page.sourcePositions.join('; '),
    ]);
  }
  return writeFileAtomic(outputPath, renderCsv(rows), 'pages.csv');
}

export type PagesOutputOptions = {
  enrichmentId: string;
  sourceRunId: string;
  pages: PageRecord[];
};

export function writePagesJson(outputPath: string, options: PagesOutputOptions): Promise<void> {
  const payload = {
    enrichmentId: options.enrichmentId,
    sourceRunId: options.sourceRunId,
    generatedAt: new Date().toISOString(),
    pageCount: options.pages.length,
    pages: options.pages,
  };
  return writeFileAtomic(outputPath, JSON.stringify(payload, null, 2) + '\n', 'pages.json');
}

export type SiteStructureOmittedDomain = {
  domain: string;
  reason: string;
};

export function writeSiteStructureCsv(
  outputPath: string,
  records: SiteStructureRecord[],
  omitted: SiteStructureOmittedDomain[] = [],
): Promise<void> {
  const header = [
    'domain',
    'homepage_status',
    'robots_status',
    'sitemap_type',
    'declared_sitemap_count',
    'discovered_url_count',
    'sampled_url_count',
    'sampled_urls',
    'errors',
    'cache_status',
    'fetched_at',
    'omitted',
    'omit_reason',
  ];
  const rows: string[][] = [header];
  for (const record of records) {
    rows.push([
      record.domain,
      record.homepageStatus,
      record.robotsStatus,
      record.sitemapType,
      String(record.declaredSitemapCount),
      String(record.discoveredUrlCount),
      String(record.sampledUrls.length),
      record.sampledUrls.join('; '),
      record.errors.map((e) => `${e.url}: ${e.error}`).join('; '),
      record.cacheStatus,
      record.fetchedAt,
      'false',
      '',
    ]);
  }
  for (const item of omitted) {
    rows.push([
      item.domain,
      'skipped',
      '',
      'none',
      '0',
      '0',
      '0',
      '',
      '',
      'none',
      '',
      'true',
      item.reason,
    ]);
  }
  return writeFileAtomic(outputPath, renderCsv(rows), 'site-structure.csv');
}

export type SiteStructureOutputOptions = {
  enrichmentId: string;
  sourceRunId: string;
  records: SiteStructureRecord[];
  omitted?: SiteStructureOmittedDomain[];
};

export function writeSiteStructureJson(outputPath: string, options: SiteStructureOutputOptions): Promise<void> {
  const omitted = options.omitted ?? [];
  const payload = {
    enrichmentId: options.enrichmentId,
    sourceRunId: options.sourceRunId,
    generatedAt: new Date().toISOString(),
    domainCount: options.records.length,
    omittedCount: omitted.length,
    discoveredDomainCount: options.records.length + omitted.length,
    records: options.records,
    omitted,
  };
  return writeFileAtomic(outputPath, JSON.stringify(payload, null, 2) + '\n', 'site-structure.json');
}

async function writeFileAtomic(path: string, content: string, description: string): Promise<void> {
  await writeTextAtomic(path, content, description);
}
