import { writeTextAtomic } from '../runs/run.js';
import { renderCsv } from '../exports/csv.js';
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
  const rows: string[][] = [header];
  for (const cluster of clusters) {
    rows.push([
      cluster.clusterId,
      cluster.canonicalKeyword,
      String(cluster.memberCount),
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
  return writeFileAtomic(outputPath, JSON.stringify(payload, null, 2) + '\n', 'keyword-clusters.json');
}

async function writeFileAtomic(path: string, content: string, description: string): Promise<void> {
  await writeTextAtomic(path, content, description);
}
