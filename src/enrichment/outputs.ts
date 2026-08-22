import { writeTextAtomic } from '../runs/run.js';
import type { KeywordCluster } from './types.js';

export type ClusterOutputOptions = {
  enrichmentId: string;
  outputDirectory: string;
  clusters: KeywordCluster[];
  algorithmVersion: string;
  config: {
    topN: number;
    edgeRule: { minSharedDomains: number; minJaccard: number };
  };
};

function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function writeKeywordClustersCsv(outputPath: string, clusters: KeywordCluster[]): Promise<void> {
  const header = [
    'cluster_id',
    'canonical_keyword',
    'member_count',
    'members',
    'median_volume',
    'average_volume',
    'representative_domains',
  ];
  const lines = [header.join(',')];
  for (const cluster of clusters) {
    lines.push([
      escapeCsvField(cluster.clusterId),
      escapeCsvField(cluster.canonicalKeyword),
      String(cluster.memberCount),
      escapeCsvField(cluster.members.map((m) => m.keyword).join('; ')),
      cluster.medianVolume !== null ? String(cluster.medianVolume) : '',
      cluster.averageVolume !== null ? cluster.averageVolume.toFixed(2) : '',
      escapeCsvField(cluster.representativeDomains.join('; ')),
    ].join(','));
  }
  return writeTextAtomic(outputPath, lines.join('\n') + '\n', 'keyword-clusters.csv');
}

export function writeKeywordClustersJson(
  outputPath: string,
  options: ClusterOutputOptions,
): Promise<void> {
  const payload = {
    enrichmentId: options.enrichmentId,
    algorithmVersion: options.algorithmVersion,
    generatedAt: new Date().toISOString(),
    config: options.config,
    clusterCount: options.clusters.length,
    clusters: options.clusters.map((c) => ({
      clusterId: c.clusterId,
      canonicalKeyword: c.canonicalKeyword,
      memberCount: c.memberCount,
      members: c.members,
      medianVolume: c.medianVolume,
      averageVolume: c.averageVolume,
      representativeDomains: c.representativeDomains,
    })),
  };
  return writeTextAtomic(outputPath, JSON.stringify(payload, null, 2) + '\n', 'keyword-clusters.json');
}
