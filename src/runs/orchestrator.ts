import type { ResearchConfig } from '../config/config.js';
import type { SeedKeyword } from '../input/seeds/normalize.js';
import type { CollectionResult } from '../browser/collect.js';
import type { SerpResult } from '../google/serp.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import {
  buildKeywordRecords,
  writeJsonFile,
  type KeywordRecord,
  type RunManifest,
} from './run.js';

export type CollectKeywordFn = (keyword: KeywordRecord, debugRoot: string) => Promise<CollectionResult>;

export type OrchestrationResult = {
  runId: string;
  records: KeywordRecord[];
  serpRows: SerpResult[];
  geoWarnings: string[];
  manifest: RunManifest;
};

export async function runKeywordBatch(
  runId: string,
  config: ResearchConfig,
  keywords: SeedKeyword[],
  input: { kind: 'seeds'; path: string },
  runDirectory: string,
  debugRoot: string,
  collect: CollectKeywordFn,
  logger: (line: string) => void = console.log,
): Promise<OrchestrationResult> {
  const records: KeywordRecord[] = buildKeywordRecords(keywords);
  const serpRows: SerpResult[] = [];
  const geoWarnings: string[] = [];

  const manifest: RunManifest = {
    runId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: 'running',
    input,
    configSnapshot: config,
    parserVersions: {
      surfer: SURFER_PARSER_VERSION,
      google: GOOGLE_PARSER_VERSION,
    },
    progress: {
      totalKeywords: keywords.length,
      completedKeywords: 0,
      errors: 0,
    },
  };
  await writeJsonFile(`${runDirectory}/manifest.json`, manifest, 'run manifest');

  for (let index = 0; index < keywords.length; index += 1) {
    const record = records[index] as KeywordRecord;
    record.status = 'running';
    logger(`[${index + 1}/${keywords.length}] ${record.normalizedKeyword}`);

    const { record: result, serpRows: rowsForKeyword, debugArtifactPath } = await collect(record, debugRoot);
    records[index] = result;
    serpRows.push(...rowsForKeyword);

    if (result.surfer) {
      const volume = formatVolume(result.surfer.volume);
      const cpc = result.surfer.cpc === null ? 'n/a' : `$${result.surfer.cpc.toFixed(2)}`;
      logger(`  ✓ volume: ${volume} | cpc: ${cpc} | organic: ${rowsForKeyword.length}`);
    } else {
      logger(`  ✗ surfer: ${result.error?.code ?? 'unknown'} (${result.error?.message ?? ''})`);
    }

    if (result.google?.geoWarning) {
      const warning = `SERP GEO WARNING: target ${config.research.market}, Google detected location: ${result.google.detectedLocation}`;
      logger(`  ⚠ ${warning}`);
      geoWarnings.push(`${result.normalizedKeyword}: ${warning}`);
    }

    if (debugArtifactPath) {
      logger(`  ⚠ parser debug artifacts saved to ${debugArtifactPath}`);
    }

    manifest.progress.completedKeywords = records.filter(
      (item) => item.status === 'completed' || item.status === 'partial' || item.status === 'failed',
    ).length;
    manifest.progress.errors = records.filter(
      (item) => item.status === 'failed' || item.status === 'partial',
    ).length;
    manifest.updatedAt = new Date().toISOString();
    await writeJsonFile(`${runDirectory}/manifest.json`, manifest, 'run manifest');
  }

  await writeJsonFile(`${runDirectory}/keywords.json`, records, 'keywords output');
  await writeJsonFile(`${runDirectory}/serp.json`, serpRows, 'SERP output');

  const failed = records.filter((item) => item.status === 'failed').length;
  const partial = records.filter((item) => item.status === 'partial').length;
  manifest.state = failed > 0 || partial > 0 ? 'completed_with_errors' : 'completed';
  manifest.updatedAt = new Date().toISOString();
  await writeJsonFile(`${runDirectory}/manifest.json`, manifest, 'run manifest');

  logger('');
  if (geoWarnings.length > 0) {
    logger(`Geo warnings (${geoWarnings.length}):`);
    for (const warning of geoWarnings) logger(`  ⚠ ${warning}`);
    logger('');
  }

  if (failed > 0 || partial > 0) {
    logger(`Run finished with ${failed} failed and ${partial} partial keyword(s).`);
    for (const item of records) {
      if (item.status === 'failed' || item.status === 'partial') {
        logger(`  ✗ ${item.normalizedKeyword}: ${item.error?.code} — ${item.error?.message}`);
      }
    }
  } else {
    logger(`Run finished: ${records.length}/${keywords.length} keywords collected.`);
  }

  logger(`Outputs: ${runDirectory}/manifest.json, keywords.json, serp.json`);

  return { runId, records, serpRows, geoWarnings, manifest };
}

function formatVolume(volume: number | null): string {
  if (volume === null) return 'n/a';
  return volume.toLocaleString('en-US');
}