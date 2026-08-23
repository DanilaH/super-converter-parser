import { writeTextAtomic } from '../runs/run.js';
import { renderCsv } from '../exports/csv.js';
import type {
  QuerySuggestionResult,
  QuerySuggestion,
  QuerySuggestionsConfig,
  QuerySuggestionSource,
} from './types.js';

export type QuerySuggestionSourceRecord = {
  normalizedParent: string;
  source: QuerySuggestionSource;
  status: string;
  error: string | null;
  fetchedAt: string;
};

export type QuerySuggestionsOutputOptions = {
  enrichmentId: string;
  sourceRunId: string;
  outputDirectory: string;
  suggestions: QuerySuggestion[];
  perSourceStatus: QuerySuggestionResult['perSourceStatus'];
  sourceStats: QuerySuggestionResult['sourceStats'];
  sourceRecords: QuerySuggestionSourceRecord[];
  inputCount: number;
  emptyCount: number;
  errorCount: number;
  algorithmVersion: string;
  config: QuerySuggestionsConfig;
};

export function writeQuerySuggestionsCsv(outputPath: string, result: QuerySuggestionResult): Promise<void> {
  const header = [
    'normalized_suggestion',
    'raw_text',
    'parent_keywords',
    'sources',
    'volume',
    'cpc',
    'ordinal',
    'market',
    'hl',
    'gl',
    'parser_version',
    'collection_status',
    'occurrences',
  ];
  const rows: string[][] = [header];
  for (const suggestion of result.suggestions) {
    rows.push([
      suggestion.normalizedSuggestion,
      suggestion.rawText,
      suggestion.occurrences.map((o) => o.parentKeyword).join('; '),
      suggestion.occurrences.map((o) => o.source).join('; '),
      suggestion.volume !== null ? String(suggestion.volume) : '',
      suggestion.cpc !== null ? String(suggestion.cpc) : '',
      suggestion.ordinal !== null ? String(suggestion.ordinal) : '',
      suggestion.market,
      suggestion.hl,
      suggestion.gl,
      suggestion.parserVersion,
      suggestion.collectionStatus,
      String(suggestion.occurrences.length),
    ]);
  }
  return writeFileAtomic(outputPath, renderCsv(rows), 'query-suggestions.csv');
}

export function writeQuerySuggestionsJson(
  outputPath: string,
  options: QuerySuggestionsOutputOptions,
): Promise<void> {
  const payload = {
    enrichmentId: options.enrichmentId,
    sourceRunId: options.sourceRunId,
    algorithmVersion: options.algorithmVersion,
    generatedAt: new Date().toISOString(),
    config: options.config,
    inputCount: options.inputCount,
    emptyCount: options.emptyCount,
    errorCount: options.errorCount,
    perSourceStatus: options.perSourceStatus,
    sourceStats: options.sourceStats,
    sourceRecords: options.sourceRecords,
    suggestionCount: options.suggestions.length,
    suggestions: options.suggestions.map((s) => ({
      normalizedSuggestion: s.normalizedSuggestion,
      rawText: s.rawText,
      volume: s.volume,
      cpc: s.cpc,
      ordinal: s.ordinal,
      market: s.market,
      hl: s.hl,
      gl: s.gl,
      parserVersion: s.parserVersion,
      collectionStatus: s.collectionStatus,
      occurrences: s.occurrences,
    })),
  };
  return writeFileAtomic(outputPath, JSON.stringify(payload, null, 2) + '\n', 'query-suggestions.json');
}

async function writeFileAtomic(path: string, content: string, description: string): Promise<void> {
  await writeTextAtomic(path, content, description);
}
