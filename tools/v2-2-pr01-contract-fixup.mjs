import { readFile, writeFile } from 'node:fs/promises';

async function replaceOnce(path, before, after) {
  const source = await readFile(path, 'utf8');
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${path}: expected patch anchor not found`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${path}: patch anchor is not unique`);
  }
  await writeFile(path, source.slice(0, first) + after + source.slice(first + before.length), 'utf8');
}

await replaceOnce(
  'src/spikes/historicalSources/spike.ts',
  '    earliestSampledCaptureUrl: null,\n    earliestMatchedCollectionId: null,',
  '    earliestSampledCaptureUrl: null,\n    earliestSampledCaptureHttpStatus: null,\n    earliestMatchedCollectionId: null,',
);

await replaceOnce(
  'src/spikes/historicalSources/spike.test.ts',
  '    earliestSampledCaptureUrl: date ? `https://${domain}/` : null,\n    earliestMatchedCollectionId: date ? \'CC-MAIN-2026-34\' : null,',
  '    earliestSampledCaptureUrl: date ? `https://${domain}/` : null,\n    earliestSampledCaptureHttpStatus: date ? \'200\' : null,\n    earliestMatchedCollectionId: date ? \'CC-MAIN-2026-34\' : null,',
);
