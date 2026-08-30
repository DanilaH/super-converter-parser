import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import {
  archiveResearchDirectory,
  resolveEnrichmentLocation,
  resolveRunLocation,
} from '../outputs/researchLayout.js';
import { ResearchError } from '../shared/errors.js';
import { buildZip } from './zip.js';

export const RESEARCH_LIBRARY_SCHEMA_VERSION = 1;
export const RESEARCH_LIBRARY_DIRECTORY = 'research-library';

const DISCOVERY_PUBLIC_ARTIFACTS = [
  'manifest.json',
  'keywords.json',
  'serp.json',
  'run-quality.json',
  'keywords.csv',
  'related-keywords.csv',
  'serp.csv',
  'domains.csv',
  'candidates.csv',
  'report.md',
  'status.json',
] as const;

export type PublishResearchToLibraryOptions = {
  outputRoot: string;
  enrichmentId: string;
  now?: () => Date;
};

export type PublishResearchToLibraryResult = {
  changed: boolean;
  publicationId: string;
  supersedesPublicationId: string | null;
  libraryDirectory: string;
  libraryDbPath: string;
  libraryJsonPath: string;
  libraryArchivePath: string;
  publicationArchivePath: string;
  publicationCount: number;
};

type ArtifactDigest = {
  path: string;
  sha256: string;
  sizeBytes: number;
};

type NormalizedKeyword = {
  keywordIdx: number;
  keywordId: string;
  keyword: string;
  normalizedKeyword: string;
  status: string;
  volume: number | null;
  cpc: number | null;
  clusterId: string | null;
  rawJson: string;
};

type NormalizedCluster = {
  clusterId: string;
  canonicalKeyword: string;
  memberCount: number;
  membersJson: string;
  representativeKeywordIdsJson: string;
  representativeKeywordsJson: string;
  buildDecision: string | null;
  seoProductRole: string | null;
  auditFlagsJson: string;
  finalistJson: string | null;
};

type NormalizedEntrantDomain = {
  clusterId: string;
  registrableDomain: string;
  bestRank: number | null;
  medianRank: number | null;
  occurrenceCount: number;
  queryCoverageRatio: number | null;
  drStatus: string | null;
  dr: number | null;
  isWeak: boolean | null;
  historyCoverageStatus: string | null;
  registrationDate: string | null;
  firstSeenDate: string | null;
  isYoung: boolean | null;
  isRecentWebPresence: boolean | null;
  possibleHistoryConflict: boolean | null;
  domainJson: string;
  historyJson: string | null;
};

type NormalizedSnapshot = {
  keywords: NormalizedKeyword[];
  clusters: NormalizedCluster[];
  entrantDomains: NormalizedEntrantDomain[];
  finalistCount: number;
};

type PublicationRow = {
  publication_id: string;
  snapshot_fingerprint: string;
  source_run_id: string;
  enrichment_id: string;
  research_name: string;
  research_relative_path: string;
  archive_relative_path: string;
  source_state: string;
  enrichment_state: string;
  source_created_at: string | null;
  source_updated_at: string | null;
  enrichment_updated_at: string | null;
  published_at: string;
  supersedes_publication_id: string | null;
  keyword_count: number;
  cluster_count: number;
  finalist_count: number;
  entrant_domain_count: number;
  summary_json: string;
};

type LibraryIndexPublication = {
  publicationId: string;
  researchName: string;
  sourceRunId: string;
  enrichmentId: string;
  publishedAt: string;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  enrichmentUpdatedAt: string | null;
  sourceState: string;
  enrichmentState: string;
  snapshotFingerprint: string;
  supersedesPublicationId: string | null;
  sourcePath: string;
  archivePath: string;
  counts: {
    keywords: number;
    clusters: number;
    finalists: number;
    entrantDomains: number;
  };
  decisions: Array<{
    clusterId: string;
    canonicalKeyword: string;
    buildDecision: string | null;
    seoProductRole: string | null;
  }>;
  summary: unknown;
};

export async function publishResearchToLibrary(
  options: PublishResearchToLibraryOptions,
): Promise<PublishResearchToLibraryResult> {
  const outputRoot = resolve(options.outputRoot);
  const nowDate = options.now?.() ?? new Date();
  const publishedAt = nowDate.toISOString();
  const enrichmentLocation = await resolveEnrichmentLocation(outputRoot, options.enrichmentId);
  if (enrichmentLocation.legacy) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      'Research library publication supports the current durable output layout only; legacy enrichment directories are not merged implicitly.',
    );
  }

  const enrichmentManifestPath = join(enrichmentLocation.enrichmentDirectory, 'manifest.json');
  const enrichmentManifest = requireRecord(
    await readJson(enrichmentManifestPath, 'enrichment manifest'),
    'enrichment manifest',
  );
  const enrichmentId = requiredString(enrichmentManifest, 'enrichmentId', 'enrichment manifest');
  if (enrichmentId !== options.enrichmentId) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Enrichment manifest identity mismatch: requested ${options.enrichmentId}, found ${enrichmentId}.`,
    );
  }
  const enrichmentState = requiredString(enrichmentManifest, 'state', 'enrichment manifest');
  if (enrichmentState !== 'completed') {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Research library publication requires a completed enrichment; ${enrichmentId} is ${enrichmentState}.`,
    );
  }
  const sourceRunId = requiredString(enrichmentManifest, 'sourceRunId', 'enrichment manifest');
  const enrichmentArtifacts = artifactNames(enrichmentManifest);

  const sourceLocation = await resolveRunLocation(outputRoot, sourceRunId);
  if (sourceLocation.legacy || resolve(sourceLocation.researchDirectory) !== resolve(enrichmentLocation.researchDirectory)) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      'Research library publication requires discovery and enrichment to share the current durable research directory.',
    );
  }

  const discoveryManifestPath = join(sourceLocation.discoveryDirectory, 'manifest.json');
  const discoveryManifest = requireRecord(
    await readJson(discoveryManifestPath, 'discovery manifest'),
    'discovery manifest',
  );
  const manifestRunId = requiredString(discoveryManifest, 'runId', 'discovery manifest');
  if (manifestRunId !== sourceRunId) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Discovery manifest identity mismatch: expected ${sourceRunId}, found ${manifestRunId}.`,
    );
  }
  const sourceState = requiredString(discoveryManifest, 'state', 'discovery manifest');
  if (sourceState !== 'completed' && sourceState !== 'completed_with_errors') {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Research library publication requires terminal discovery evidence; ${sourceRunId} is ${sourceState}.`,
    );
  }

  // Refresh the source-level portable archive first. This preserves the existing
  // manifest-gated archive truth and means every library publication has an exact
  // portable copy of the research that was published.
  const sourceArchivePath = await archiveResearchDirectory(enrichmentLocation.researchDirectory);
  const sourceArchive = await readFile(sourceArchivePath);
  const sourceArchiveSha256 = sha256(sourceArchive);

  const artifactDigests = await collectSnapshotArtifactDigests({
    researchDirectory: enrichmentLocation.researchDirectory,
    discoveryDirectory: sourceLocation.discoveryDirectory,
    enrichmentDirectory: enrichmentLocation.enrichmentDirectory,
    enrichmentArtifacts,
  });
  const snapshotFingerprint = fingerprintArtifacts(artifactDigests);
  const publicationId = `pub_${snapshotFingerprint}`;

  const keywordsJson = await readJson(
    join(sourceLocation.discoveryDirectory, 'keywords.json'),
    'discovery keywords',
  );
  const clustersJson = await readPublishedEnrichmentJson(
    enrichmentLocation.enrichmentDirectory,
    enrichmentArtifacts,
    'keyword-clusters.json',
  );
  const representativesJson = await readPublishedEnrichmentJson(
    enrichmentLocation.enrichmentDirectory,
    enrichmentArtifacts,
    'representative-queries.json',
  );
  const entrantJson = await readPublishedEnrichmentJson(
    enrichmentLocation.enrichmentDirectory,
    enrichmentArtifacts,
    'entrant-cohort.json',
  );
  const historyJson = await readPublishedEnrichmentJson(
    enrichmentLocation.enrichmentDirectory,
    enrichmentArtifacts,
    'cohort-history.json',
  );
  const finalistJson = await readPublishedEnrichmentJson(
    enrichmentLocation.enrichmentDirectory,
    enrichmentArtifacts,
    'finalist-evidence-matrix.json',
  );

  const normalized = normalizeSnapshot({
    keywordsJson,
    clustersJson,
    representativesJson,
    entrantJson,
    historyJson,
    finalistJson,
  });

  const libraryDirectory = join(outputRoot, RESEARCH_LIBRARY_DIRECTORY);
  const publicationsDirectory = join(libraryDirectory, 'researches');
  const libraryDbPath = join(libraryDirectory, 'library.sqlite');
  const libraryJsonPath = join(libraryDirectory, 'library.json');
  const libraryArchivePath = join(libraryDirectory, 'library.zip');
  const publicationArchiveRelativePath = `researches/${publicationId}.zip`;
  const publicationArchivePath = join(publicationsDirectory, `${publicationId}.zip`);
  await mkdir(publicationsDirectory, { recursive: true });

  const db = new Database(libraryDbPath);
  let changed = false;
  let supersedesPublicationId: string | null = null;
  let copiedArchive = false;
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = DELETE');
    applySchema(db);

    const existing = db.prepare(
      'SELECT publication_id, supersedes_publication_id FROM publications WHERE snapshot_fingerprint = ?',
    ).get(snapshotFingerprint) as { publication_id: string; supersedes_publication_id: string | null } | undefined;

    if (existing) {
      supersedesPublicationId = existing.supersedes_publication_id;
      if (!(await pathExists(publicationArchivePath))) {
        await copyFileAtomic(sourceArchivePath, publicationArchivePath);
        copiedArchive = true;
        db.prepare(`
          UPDATE publications
          SET source_archive_sha256 = ?, source_archive_size = ?
          WHERE publication_id = ?
        `).run(sourceArchiveSha256, sourceArchive.length, publicationId);
      }
    } else {
      const previous = db.prepare(`
        SELECT publication_id
        FROM publications
        WHERE enrichment_id = ?
        ORDER BY published_at DESC, rowid DESC
        LIMIT 1
      `).get(enrichmentId) as { publication_id: string } | undefined;
      supersedesPublicationId = previous?.publication_id ?? null;

      await copyFileAtomic(sourceArchivePath, publicationArchivePath);
      copiedArchive = true;

      const researchRelativePath = safeRelative(outputRoot, enrichmentLocation.researchDirectory);
      const researchName = basename(enrichmentLocation.researchDirectory);
      const sourceCreatedAt = optionalString(discoveryManifest.createdAt);
      const sourceUpdatedAt = optionalString(discoveryManifest.updatedAt);
      const enrichmentUpdatedAt = optionalString(enrichmentManifest.updatedAt);
      const summaryJson = JSON.stringify(buildPublicationSummary(enrichmentManifest));

      const insert = db.transaction(() => {
        db.prepare(`
          INSERT INTO publications (
            publication_id, snapshot_fingerprint, source_run_id, enrichment_id,
            research_name, research_relative_path, archive_relative_path,
            source_archive_sha256, source_archive_size,
            source_state, enrichment_state, source_created_at, source_updated_at,
            enrichment_updated_at, published_at, supersedes_publication_id,
            keyword_count, cluster_count, finalist_count, entrant_domain_count,
            summary_json
          ) VALUES (
            @publicationId, @snapshotFingerprint, @sourceRunId, @enrichmentId,
            @researchName, @researchRelativePath, @archiveRelativePath,
            @sourceArchiveSha256, @sourceArchiveSize,
            @sourceState, @enrichmentState, @sourceCreatedAt, @sourceUpdatedAt,
            @enrichmentUpdatedAt, @publishedAt, @supersedesPublicationId,
            @keywordCount, @clusterCount, @finalistCount, @entrantDomainCount,
            @summaryJson
          )
        `).run({
          publicationId,
          snapshotFingerprint,
          sourceRunId,
          enrichmentId,
          researchName,
          researchRelativePath,
          archiveRelativePath: publicationArchiveRelativePath,
          sourceArchiveSha256,
          sourceArchiveSize: sourceArchive.length,
          sourceState,
          enrichmentState,
          sourceCreatedAt,
          sourceUpdatedAt,
          enrichmentUpdatedAt,
          publishedAt,
          supersedesPublicationId,
          keywordCount: normalized.keywords.length,
          clusterCount: normalized.clusters.length,
          finalistCount: normalized.finalistCount,
          entrantDomainCount: normalized.entrantDomains.length,
          summaryJson,
        });

        const artifactStatement = db.prepare(`
          INSERT INTO publication_artifacts (
            publication_id, artifact_path, sha256, size_bytes
          ) VALUES (?, ?, ?, ?)
        `);
        for (const artifact of artifactDigests) {
          artifactStatement.run(publicationId, artifact.path, artifact.sha256, artifact.sizeBytes);
        }

        const keywordStatement = db.prepare(`
          INSERT INTO publication_keywords (
            publication_id, keyword_idx, keyword_id, keyword, normalized_keyword,
            status, volume, cpc, cluster_id, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const keyword of normalized.keywords) {
          keywordStatement.run(
            publicationId,
            keyword.keywordIdx,
            keyword.keywordId,
            keyword.keyword,
            keyword.normalizedKeyword,
            keyword.status,
            keyword.volume,
            keyword.cpc,
            keyword.clusterId,
            keyword.rawJson,
          );
        }

        const clusterStatement = db.prepare(`
          INSERT INTO publication_clusters (
            publication_id, cluster_id, canonical_keyword, member_count,
            members_json, representative_keyword_ids_json, representative_keywords_json,
            build_decision, seo_product_role, audit_flags_json, finalist_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const cluster of normalized.clusters) {
          clusterStatement.run(
            publicationId,
            cluster.clusterId,
            cluster.canonicalKeyword,
            cluster.memberCount,
            cluster.membersJson,
            cluster.representativeKeywordIdsJson,
            cluster.representativeKeywordsJson,
            cluster.buildDecision,
            cluster.seoProductRole,
            cluster.auditFlagsJson,
            cluster.finalistJson,
          );
        }

        const domainStatement = db.prepare(`
          INSERT INTO publication_entrant_domains (
            publication_id, cluster_id, registrable_domain,
            best_rank, median_rank, occurrence_count, query_coverage_ratio,
            dr_status, dr, is_weak, history_coverage_status,
            registration_date, first_seen_date, is_young,
            is_recent_web_presence, possible_history_conflict,
            domain_json, history_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const domain of normalized.entrantDomains) {
          domainStatement.run(
            publicationId,
            domain.clusterId,
            domain.registrableDomain,
            domain.bestRank,
            domain.medianRank,
            domain.occurrenceCount,
            domain.queryCoverageRatio,
            domain.drStatus,
            domain.dr,
            dbBoolean(domain.isWeak),
            domain.historyCoverageStatus,
            domain.registrationDate,
            domain.firstSeenDate,
            dbBoolean(domain.isYoung),
            dbBoolean(domain.isRecentWebPresence),
            dbBoolean(domain.possibleHistoryConflict),
            domain.domainJson,
            domain.historyJson,
          );
        }
      });

      insert();
      changed = true;
    }
  } catch (error) {
    if (copiedArchive && changed === false) {
      await rm(publicationArchivePath, { force: true }).catch(() => undefined);
    }
    if (error instanceof ResearchError) throw error;
    throw new ResearchError('DB_ERROR', 'Failed to publish research into library.sqlite.', { cause: error });
  } finally {
    db.close();
  }

  // library.sqlite is the durable truth. JSON and ZIP are derived snapshots and
  // may be regenerated on an idempotent publish if a previous filesystem write
  // was interrupted.
  const index = buildLibraryIndex(libraryDbPath, publishedAt);
  await writeAtomic(libraryJsonPath, Buffer.from(`${JSON.stringify(index, null, 2)}\n`, 'utf8'));
  await writeLibraryArchive({
    libraryDirectory,
    libraryDbPath,
    libraryJsonPath,
    libraryArchivePath,
    publications: index.publications,
    generatedAt: nowDate,
  });

  return {
    changed,
    publicationId,
    supersedesPublicationId,
    libraryDirectory,
    libraryDbPath,
    libraryJsonPath,
    libraryArchivePath,
    publicationArchivePath,
    publicationCount: index.publicationCount,
  };
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_library_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
  `);
  const current = db.prepare(
    'SELECT version FROM research_library_schema WHERE singleton = 1',
  ).get() as { version: number } | undefined;
  if (current && current.version !== RESEARCH_LIBRARY_SCHEMA_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Research library schema version ${current.version} is unsupported by this build (${RESEARCH_LIBRARY_SCHEMA_VERSION}).`,
    );
  }
  if (!current) {
    db.prepare(
      'INSERT INTO research_library_schema (singleton, version) VALUES (1, ?)',
    ).run(RESEARCH_LIBRARY_SCHEMA_VERSION);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS publications (
      publication_id TEXT PRIMARY KEY,
      snapshot_fingerprint TEXT NOT NULL UNIQUE,
      source_run_id TEXT NOT NULL,
      enrichment_id TEXT NOT NULL,
      research_name TEXT NOT NULL,
      research_relative_path TEXT NOT NULL,
      archive_relative_path TEXT NOT NULL,
      source_archive_sha256 TEXT NOT NULL,
      source_archive_size INTEGER NOT NULL,
      source_state TEXT NOT NULL,
      enrichment_state TEXT NOT NULL,
      source_created_at TEXT,
      source_updated_at TEXT,
      enrichment_updated_at TEXT,
      published_at TEXT NOT NULL,
      supersedes_publication_id TEXT REFERENCES publications(publication_id),
      keyword_count INTEGER NOT NULL,
      cluster_count INTEGER NOT NULL,
      finalist_count INTEGER NOT NULL,
      entrant_domain_count INTEGER NOT NULL,
      summary_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS publications_enrichment_idx
      ON publications(enrichment_id, published_at);
    CREATE INDEX IF NOT EXISTS publications_run_idx
      ON publications(source_run_id, published_at);

    CREATE TABLE IF NOT EXISTS publication_artifacts (
      publication_id TEXT NOT NULL REFERENCES publications(publication_id) ON DELETE CASCADE,
      artifact_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      PRIMARY KEY (publication_id, artifact_path)
    );

    CREATE TABLE IF NOT EXISTS publication_keywords (
      publication_id TEXT NOT NULL REFERENCES publications(publication_id) ON DELETE CASCADE,
      keyword_idx INTEGER NOT NULL,
      keyword_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      normalized_keyword TEXT NOT NULL,
      status TEXT NOT NULL,
      volume REAL,
      cpc REAL,
      cluster_id TEXT,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (publication_id, keyword_idx)
    );
    CREATE INDEX IF NOT EXISTS publication_keywords_text_idx
      ON publication_keywords(normalized_keyword);
    CREATE INDEX IF NOT EXISTS publication_keywords_cluster_idx
      ON publication_keywords(publication_id, cluster_id);

    CREATE TABLE IF NOT EXISTS publication_clusters (
      publication_id TEXT NOT NULL REFERENCES publications(publication_id) ON DELETE CASCADE,
      cluster_id TEXT NOT NULL,
      canonical_keyword TEXT NOT NULL,
      member_count INTEGER NOT NULL,
      members_json TEXT NOT NULL,
      representative_keyword_ids_json TEXT NOT NULL,
      representative_keywords_json TEXT NOT NULL,
      build_decision TEXT,
      seo_product_role TEXT,
      audit_flags_json TEXT NOT NULL,
      finalist_json TEXT,
      PRIMARY KEY (publication_id, cluster_id)
    );
    CREATE INDEX IF NOT EXISTS publication_clusters_canonical_idx
      ON publication_clusters(canonical_keyword);
    CREATE INDEX IF NOT EXISTS publication_clusters_decision_idx
      ON publication_clusters(build_decision);

    CREATE TABLE IF NOT EXISTS publication_entrant_domains (
      publication_id TEXT NOT NULL REFERENCES publications(publication_id) ON DELETE CASCADE,
      cluster_id TEXT NOT NULL,
      registrable_domain TEXT NOT NULL,
      best_rank REAL,
      median_rank REAL,
      occurrence_count INTEGER NOT NULL,
      query_coverage_ratio REAL,
      dr_status TEXT,
      dr REAL,
      is_weak INTEGER,
      history_coverage_status TEXT,
      registration_date TEXT,
      first_seen_date TEXT,
      is_young INTEGER,
      is_recent_web_presence INTEGER,
      possible_history_conflict INTEGER,
      domain_json TEXT NOT NULL,
      history_json TEXT,
      PRIMARY KEY (publication_id, cluster_id, registrable_domain)
    );
    CREATE INDEX IF NOT EXISTS publication_domains_domain_idx
      ON publication_entrant_domains(registrable_domain);
    CREATE INDEX IF NOT EXISTS publication_domains_cluster_idx
      ON publication_entrant_domains(publication_id, cluster_id);
  `);
}

function normalizeSnapshot(input: {
  keywordsJson: unknown;
  clustersJson: unknown | null;
  representativesJson: unknown | null;
  entrantJson: unknown | null;
  historyJson: unknown | null;
  finalistJson: unknown | null;
}): NormalizedSnapshot {
  const representativeByCluster = buildRepresentativeMap(input.representativesJson);
  const finalistByCluster = buildFinalistMap(input.finalistJson);
  const clusterByKeywordIdx = new Map<number, string>();
  const clusters: NormalizedCluster[] = [];

  if (input.clustersJson !== null) {
    const root = requireRecord(input.clustersJson, 'keyword-clusters.json');
    const rawClusters = recordArray(root.clusters, 'keyword-clusters.json clusters');
    for (const rawCluster of rawClusters) {
      const clusterId = requiredString(rawCluster, 'clusterId', 'cluster');
      const canonicalKeyword = requiredString(rawCluster, 'canonicalKeyword', `cluster ${clusterId}`);
      const members = recordArray(rawCluster.members, `cluster ${clusterId} members`);
      for (const member of members) {
        const keywordIdx = optionalNumber(member.keywordIdx);
        if (keywordIdx !== null && Number.isInteger(keywordIdx)) {
          clusterByKeywordIdx.set(keywordIdx, clusterId);
        }
      }

      const representative = representativeByCluster.get(clusterId);
      const finalist = finalistByCluster.get(clusterId);
      const humanDecision = finalist ? optionalRecord(finalist.humanDecision) : null;
      clusters.push({
        clusterId,
        canonicalKeyword,
        memberCount: optionalNumber(rawCluster.memberCount) ?? members.length,
        membersJson: JSON.stringify(members),
        representativeKeywordIdsJson: JSON.stringify(representative?.ids ?? []),
        representativeKeywordsJson: JSON.stringify(representative?.keywords ?? []),
        buildDecision: humanDecision ? optionalString(humanDecision.buildDecision) : null,
        seoProductRole: humanDecision ? optionalString(humanDecision.seoProductRole) : null,
        auditFlagsJson: JSON.stringify(finalist ? stringArray(finalist.auditFlags) : []),
        finalistJson: finalist ? JSON.stringify(finalist) : null,
      });
    }
  }

  const keywordRows = valueArray(input.keywordsJson, 'keywords.json');
  const keywords: NormalizedKeyword[] = keywordRows.map((value, keywordIdx) => {
    const row = requireRecord(value, `keywords.json row ${keywordIdx}`);
    const surfer = optionalRecord(row.surfer);
    return {
      keywordIdx,
      keywordId: requiredString(row, 'id', `keywords.json row ${keywordIdx}`),
      keyword: requiredString(row, 'keyword', `keywords.json row ${keywordIdx}`),
      normalizedKeyword: requiredString(row, 'normalizedKeyword', `keywords.json row ${keywordIdx}`),
      status: requiredString(row, 'status', `keywords.json row ${keywordIdx}`),
      volume: surfer ? optionalNumber(surfer.volume) : null,
      cpc: surfer ? optionalNumber(surfer.cpc) : null,
      clusterId: clusterByKeywordIdx.get(keywordIdx) ?? null,
      rawJson: JSON.stringify(row),
    };
  });

  const historyByDomain = buildHistoryMap(input.historyJson);
  const entrantDomains: NormalizedEntrantDomain[] = [];
  if (input.entrantJson !== null) {
    const root = requireRecord(input.entrantJson, 'entrant-cohort.json');
    const cohorts = recordArray(root.cohorts, 'entrant-cohort.json cohorts');
    for (const cohort of cohorts) {
      const clusterId = requiredString(cohort, 'clusterId', 'entrant cohort');
      const domains = recordArray(cohort.domains, `entrant cohort ${clusterId} domains`);
      for (const domain of domains) {
        const registrableDomain = requiredString(domain, 'registrableDomain', `entrant domain ${clusterId}`);
        const queryCoverage = optionalRecord(domain.queryCoverage);
        const drEvidence = optionalRecord(domain.drEvidence);
        const history = historyByDomain.get(historyKey(clusterId, registrableDomain)) ?? null;
        const registration = history ? optionalRecord(history.registration) : null;
        const firstSeen = history ? optionalRecord(history.firstSeen) : null;
        entrantDomains.push({
          clusterId,
          registrableDomain,
          bestRank: optionalNumber(domain.bestRank),
          medianRank: optionalNumber(domain.medianRank),
          occurrenceCount: optionalNumber(domain.occurrenceCount) ?? 0,
          queryCoverageRatio: queryCoverage ? optionalNumber(queryCoverage.ratio) : null,
          drStatus: drEvidence ? optionalString(drEvidence.status) : null,
          dr: drEvidence ? optionalNumber(drEvidence.value) : null,
          isWeak: drEvidence ? optionalBoolean(drEvidence.isWeak) : null,
          historyCoverageStatus: history ? optionalString(history.coverageStatus) : null,
          registrationDate: registration ? optionalString(registration.date) : null,
          firstSeenDate: firstSeen ? optionalString(firstSeen.date) : null,
          isYoung: registration ? optionalBoolean(registration.isYoung) : null,
          isRecentWebPresence: firstSeen ? optionalBoolean(firstSeen.isRecent) : null,
          possibleHistoryConflict: history ? optionalBoolean(history.possibleHistoryConflict) : null,
          domainJson: JSON.stringify(domain),
          historyJson: history ? JSON.stringify(history) : null,
        });
      }
    }
  }

  return {
    keywords,
    clusters,
    entrantDomains,
    finalistCount: finalistByCluster.size,
  };
}

function buildRepresentativeMap(value: unknown | null): Map<string, { ids: number[]; keywords: string[] }> {
  const output = new Map<string, { ids: number[]; keywords: string[] }>();
  if (value === null) return output;
  const root = requireRecord(value, 'representative-queries.json');
  const sets = recordArray(root.sets, 'representative-queries.json sets');
  for (const set of sets) {
    const clusterId = requiredString(set, 'clusterId', 'representative query set');
    const ids = numberArray(set.representativeKeywordIds);
    const representatives = recordArray(set.representatives, `representative set ${clusterId}`);
    const keywords = representatives.map((row) => requiredString(row, 'keyword', `representative set ${clusterId}`));
    output.set(clusterId, { ids, keywords });
  }
  return output;
}

function buildFinalistMap(value: unknown | null): Map<string, Record<string, unknown>> {
  const output = new Map<string, Record<string, unknown>>();
  if (value === null) return output;
  const root = requireRecord(value, 'finalist-evidence-matrix.json');
  const matrix = requireRecord(root.matrix, 'finalist evidence matrix');
  const finalists = recordArray(matrix.finalists, 'finalist evidence matrix finalists');
  for (const finalist of finalists) {
    output.set(requiredString(finalist, 'clusterId', 'finalist'), finalist);
  }
  return output;
}

function buildHistoryMap(value: unknown | null): Map<string, Record<string, unknown>> {
  const output = new Map<string, Record<string, unknown>>();
  if (value === null) return output;
  const root = requireRecord(value, 'cohort-history.json');
  const projections = recordArray(root.projections, 'cohort-history.json projections');
  for (const projection of projections) {
    const clusterId = requiredString(projection, 'clusterId', 'cohort history projection');
    const domains = recordArray(projection.domains, `cohort history ${clusterId} domains`);
    for (const domain of domains) {
      const registrableDomain = requiredString(domain, 'registrableDomain', `cohort history ${clusterId}`);
      output.set(historyKey(clusterId, registrableDomain), domain);
    }
  }
  return output;
}

async function collectSnapshotArtifactDigests(input: {
  researchDirectory: string;
  discoveryDirectory: string;
  enrichmentDirectory: string;
  enrichmentArtifacts: Set<string>;
}): Promise<ArtifactDigest[]> {
  const files: Array<{ absolutePath: string; required: boolean }> = [];
  for (const name of DISCOVERY_PUBLIC_ARTIFACTS) {
    files.push({
      absolutePath: join(input.discoveryDirectory, name),
      required: name === 'manifest.json' || name === 'keywords.json',
    });
  }
  const enrichmentNames = new Set(['manifest.json', ...input.enrichmentArtifacts]);
  for (const name of enrichmentNames) {
    assertArtifactName(name);
    files.push({ absolutePath: join(input.enrichmentDirectory, name), required: true });
  }

  const deduped = new Map<string, { absolutePath: string; required: boolean }>();
  for (const file of files) {
    const rel = safeRelative(input.researchDirectory, file.absolutePath);
    const previous = deduped.get(rel);
    deduped.set(rel, {
      absolutePath: file.absolutePath,
      required: file.required || previous?.required === true,
    });
  }

  const output: ArtifactDigest[] = [];
  for (const [rel, file] of [...deduped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let data: Buffer;
    try {
      data = await readFile(file.absolutePath);
    } catch (error) {
      if (!file.required && isEnoent(error)) continue;
      throw new ResearchError('OUTPUT_WRITE_ERROR', `Published artifact is missing or unreadable: ${file.absolutePath}`, { cause: error });
    }
    output.push({ path: rel, sha256: sha256(data), sizeBytes: data.length });
  }
  return output;
}

function fingerprintArtifacts(artifacts: ArtifactDigest[]): string {
  const hash = createHash('sha256');
  for (const artifact of [...artifacts].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(artifact.path, 'utf8');
    hash.update('\0');
    hash.update(artifact.sha256, 'utf8');
    hash.update('\n');
  }
  return hash.digest('hex');
}

function buildPublicationSummary(manifest: Record<string, unknown>): unknown {
  return {
    modules: Array.isArray(manifest.modules) ? manifest.modules : [],
    summary: manifest.summary ?? null,
    representativeQueries: manifest.representativeQueries ?? null,
    entrantCohort: manifest.entrantCohort ?? null,
    cohortHistory: manifest.cohortHistory ?? null,
    trafficEvidence: manifest.trafficEvidence ?? null,
    finalistEvidence: manifest.finalistEvidence ?? null,
  };
}

function buildLibraryIndex(dbPath: string, generatedAt: string): {
  version: number;
  generatedAt: string;
  publicationCount: number;
  publications: LibraryIndexPublication[];
} {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`
      SELECT * FROM publications
      ORDER BY published_at ASC, rowid ASC
    `).all() as PublicationRow[];
    const decisionStatement = db.prepare(`
      SELECT cluster_id, canonical_keyword, build_decision, seo_product_role
      FROM publication_clusters
      WHERE publication_id = ? AND finalist_json IS NOT NULL
      ORDER BY cluster_id
    `);
    const publications: LibraryIndexPublication[] = rows.map((row) => {
      const decisions = decisionStatement.all(row.publication_id) as Array<{
        cluster_id: string;
        canonical_keyword: string;
        build_decision: string | null;
        seo_product_role: string | null;
      }>;
      return {
        publicationId: row.publication_id,
        researchName: row.research_name,
        sourceRunId: row.source_run_id,
        enrichmentId: row.enrichment_id,
        publishedAt: row.published_at,
        sourceCreatedAt: row.source_created_at,
        sourceUpdatedAt: row.source_updated_at,
        enrichmentUpdatedAt: row.enrichment_updated_at,
        sourceState: row.source_state,
        enrichmentState: row.enrichment_state,
        snapshotFingerprint: row.snapshot_fingerprint,
        supersedesPublicationId: row.supersedes_publication_id,
        sourcePath: row.research_relative_path,
        archivePath: row.archive_relative_path,
        counts: {
          keywords: row.keyword_count,
          clusters: row.cluster_count,
          finalists: row.finalist_count,
          entrantDomains: row.entrant_domain_count,
        },
        decisions: decisions.map((decision) => ({
          clusterId: decision.cluster_id,
          canonicalKeyword: decision.canonical_keyword,
          buildDecision: decision.build_decision,
          seoProductRole: decision.seo_product_role,
        })),
        summary: parseStoredJson(row.summary_json, `publication ${row.publication_id} summary`),
      };
    });
    return {
      version: RESEARCH_LIBRARY_SCHEMA_VERSION,
      generatedAt,
      publicationCount: publications.length,
      publications,
    };
  } finally {
    db.close();
  }
}

async function writeLibraryArchive(input: {
  libraryDirectory: string;
  libraryDbPath: string;
  libraryJsonPath: string;
  libraryArchivePath: string;
  publications: LibraryIndexPublication[];
  generatedAt: Date;
}): Promise<void> {
  const entries = [
    { name: 'library.sqlite', data: await readFile(input.libraryDbPath) },
    { name: 'library.json', data: await readFile(input.libraryJsonPath) },
  ];
  for (const publication of input.publications) {
    const archivePath = safeJoin(input.libraryDirectory, publication.archivePath);
    entries.push({
      name: publication.archivePath.split(sep).join('/'),
      data: await readFile(archivePath),
    });
  }
  const archive = buildZip(entries, input.generatedAt);
  await writeAtomic(input.libraryArchivePath, archive);
}

async function readPublishedEnrichmentJson(
  enrichmentDirectory: string,
  artifacts: Set<string>,
  name: string,
): Promise<unknown | null> {
  if (!artifacts.has(name)) return null;
  return readJson(join(enrichmentDirectory, name), name);
}

function artifactNames(manifest: Record<string, unknown>): Set<string> {
  if (!Array.isArray(manifest.artifacts)) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', 'Enrichment manifest has no artifact list.');
  }
  const output = new Set<string>();
  for (const value of manifest.artifacts) {
    if (typeof value !== 'string') {
      throw new ResearchError('OUTPUT_WRITE_ERROR', 'Enrichment manifest contains a non-string artifact name.');
    }
    assertArtifactName(value);
    output.add(value);
  }
  return output;
}

function assertArtifactName(value: string): void {
  if (value === '' || basename(value) !== value || value.includes('/') || value.includes('\\')) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Unsafe enrichment artifact name: ${value}`);
  }
}

async function readJson(path: string, description: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Cannot read ${description}: ${path}`, { cause: error });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Cannot parse ${description}: ${path}`, { cause: error });
  }
}

async function copyFileAtomic(source: string, target: string): Promise<void> {
  const temp = `${target}.tmp-${randomUUID()}`;
  try {
    await copyFile(source, temp);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to copy research archive to ${target}.`, { cause: error });
  }
}

async function writeAtomic(path: string, data: Buffer): Promise<void> {
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to write ${path}.`, { cause: error });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function safeRelative(parent: string, child: string): string {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Path is outside the expected research root: ${child}`);
  }
  return rel.split(sep).join('/');
}

function safeJoin(parent: string, child: string): string {
  const resolved = resolve(parent, child);
  const rel = relative(resolve(parent), resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Library path escapes its root: ${child}`);
  }
  return resolved;
}

function historyKey(clusterId: string, domain: string): string {
  return `${clusterId}\0${domain}`;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function dbBoolean(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}

function valueArray(value: unknown, description: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `${description} must be an array.`);
  }
  return value;
}

function recordArray(value: unknown, description: string): Record<string, unknown>[] {
  return valueArray(value, description).map((item, index) => requireRecord(item, `${description}[${index}]`));
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `${description} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(record: Record<string, unknown>, key: string, description: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `${description}.${key} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
}

function parseStoredJson(value: string, description: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new ResearchError('DB_ERROR', `Corrupt ${description}.`, { cause: error });
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
