import { readFile, writeFile } from 'node:fs/promises';

async function transform(path, fn) {
  const source = await readFile(path, 'utf8');
  const next = fn(source);
  if (next === source) throw new Error(`${path}: expected transformation made no change`);
  await writeFile(path, next, 'utf8');
}

for (const path of [
  'src/cli/cohortHistory.test.ts',
  'src/cli/entrantCohort.test.ts',
  'src/cli/representatives.test.ts',
]) {
  await transform(path, (source) => source.replace(
    /writeRunIndex\(root, \{(?!\s*version:)/g,
    'writeRunIndex(root, { version: 1,',
  ));
}

for (const path of [
  'src/cli/cohortHistory.test.ts',
  'src/cli/entrantCohort.test.ts',
  'src/cli/representatives.test.ts',
  'src/cli/trafficEvidence.test.ts',
]) {
  await transform(path, (source) => source.replace(
    /writeEnrichmentIndex\(root, \{(?!\s*version:)/g,
    'writeEnrichmentIndex(root, { version: 1,',
  ));
}

await transform('src/enrichment/clusteringSnapshot.test.ts', (source) => source.replace(
  '    averageVolume: 100,\n    algorithmVersion: CLUSTERING_ALGORITHM_VERSION,',
  '    averageVolume: 100,\n    cohesion: { pairCount: 0, urlJaccard: null, domainJaccard: null },\n    algorithmVersion: CLUSTERING_ALGORITHM_VERSION,',
));

await transform('src/enrichment/cohortHistory.test.ts', (source) => source.replace(
  '  return {\n    domain: input.domain,\n    registrationDate: null,',
  '  return {\n    registrationDate: null,',
));

for (const path of [
  'src/runs/serpEvidence.test.ts',
  'src/scoring/scoring.serpTruth.test.ts',
]) {
  await transform(path, (source) => source.replace(
    "serpStatus: NonNullable<KeywordRecord['google']>['serpStatus'],",
    "serpStatus: NonNullable<NonNullable<KeywordRecord['google']>['serpStatus']>,",
  ));
}
