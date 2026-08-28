import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ResearchError } from '../shared/errors.js';

export type ResearchLocation = {
  researchDirectory: string;
  discoveryDirectory: string;
  archivePath: string;
  legacy: boolean;
};

type RunIndexRecord = {
  version: 1;
  runId: string;
  researchDirectory: string;
  discoveryDirectory: string;
};

type EnrichmentIndexRecord = {
  version: 1;
  enrichmentId: string;
  runId: string;
  researchDirectory: string;
  enrichmentDirectory: string;
};

export function resolveOutputRoot(
  cliValue: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): string {
  const selected = cliValue?.trim() || env.RESEARCH_OUTPUT_ROOT?.trim();
  const root = selected || join(userHome, 'super-converter-parser-output');
  if (selected && !isAbsolute(root)) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Output root must be an absolute path: ${root}`);
  }
  return resolve(root);
}

export function researchSlug(value: string): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'research';
}

export async function allocateResearchLocation(
  outputRoot: string,
  label: string,
  date: Date = new Date(),
): Promise<ResearchLocation> {
  let researchDirectory: string | null = null;
  try {
    await mkdir(outputRoot, { recursive: true });
    const datePrefix = date.toISOString().slice(0, 10);
    const baseName = `${datePrefix}-${researchSlug(label)}`;
    researchDirectory = await allocateDirectory(outputRoot, baseName);
    const discoveryDirectory = join(researchDirectory, 'discovery');
    await mkdir(discoveryDirectory);
    return {
      researchDirectory,
      discoveryDirectory,
      archivePath: join(researchDirectory, 'results.zip'),
      legacy: false,
    };
  } catch (error) {
    if (researchDirectory !== null) {
      await rm(researchDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (error instanceof ResearchError) throw error;
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Failed to allocate a research directory under "${outputRoot}".`,
      { cause: error },
    );
  }
}

export async function allocateEnrichmentDirectory(researchDirectory: string): Promise<string> {
  return allocateDirectory(researchDirectory, 'enrichment');
}

export async function writeRunIndex(
  outputRoot: string,
  record: RunIndexRecord,
  beforeCleanup?: () => void | Promise<void>,
): Promise<void> {
  assertSafeId(record.runId, 'run');
  try {
    await writeIndex(join(outputRoot, 'index', 'runs', `${record.runId}.json`), record);
  } catch (error) {
    // Fresh discovery opens run.sqlite before publishing the index. Close any
    // caller-owned handles first so Windows can delete the unindexed directory.
    // The callback is best-effort because the original index failure is the
    // operator-facing error that must be preserved.
    if (beforeCleanup) {
      await Promise.resolve(beforeCleanup()).catch(() => undefined);
    }
    // Index publication still precedes creation of the durable run row, so this
    // directory is not resumable and must not survive as an orphan.
    await rm(record.researchDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeEnrichmentIndex(outputRoot: string, record: EnrichmentIndexRecord): Promise<void> {
  assertSafeId(record.enrichmentId, 'enrichment');
  await writeIndex(join(outputRoot, 'index', 'enrichments', `${record.enrichmentId}.json`), record);
}

export async function resolveRunLocation(
  outputRoot: string,
  runId: string,
  legacyCwd: string = process.cwd(),
): Promise<ResearchLocation> {
  assertSafeId(runId, 'run');
  const indexed = await readIndex<RunIndexRecord>(join(outputRoot, 'index', 'runs', `${runId}.json`));
  if (indexed) {
    assertIndexedPath(outputRoot, indexed.researchDirectory);
    assertIndexedPath(indexed.researchDirectory, indexed.discoveryDirectory);
    await requireFile(join(indexed.discoveryDirectory, 'run.sqlite'), `Run ${runId}`);
    return {
      researchDirectory: indexed.researchDirectory,
      discoveryDirectory: indexed.discoveryDirectory,
      archivePath: join(indexed.researchDirectory, 'results.zip'),
      legacy: false,
    };
  }

  const legacyDirectory = resolve(legacyCwd, 'runs', runId);
  await requireFile(join(legacyDirectory, 'run.sqlite'), `Run ${runId}`);
  return {
    researchDirectory: legacyDirectory,
    discoveryDirectory: legacyDirectory,
    archivePath: join(legacyDirectory, 'results.zip'),
    legacy: true,
  };
}

export async function resolveEnrichmentLocation(
  outputRoot: string,
  enrichmentId: string,
  legacyCwd: string = process.cwd(),
): Promise<{ researchDirectory: string; enrichmentDirectory: string; archivePath: string; legacy: boolean }> {
  assertSafeId(enrichmentId, 'enrichment');
  const indexed = await readIndex<EnrichmentIndexRecord>(join(outputRoot, 'index', 'enrichments', `${enrichmentId}.json`));
  if (indexed) {
    assertIndexedPath(outputRoot, indexed.researchDirectory);
    assertIndexedPath(indexed.researchDirectory, indexed.enrichmentDirectory);
    await requireFile(join(indexed.enrichmentDirectory, 'enrichment.sqlite'), `Enrichment ${enrichmentId}`);
    return {
      researchDirectory: indexed.researchDirectory,
      enrichmentDirectory: indexed.enrichmentDirectory,
      archivePath: join(indexed.researchDirectory, 'results.zip'),
      legacy: false,
    };
  }

  const legacyDirectory = resolve(legacyCwd, 'enrichments', enrichmentId);
  await requireFile(join(legacyDirectory, 'enrichment.sqlite'), `Enrichment ${enrichmentId}`);
  return {
    researchDirectory: legacyDirectory,
    enrichmentDirectory: legacyDirectory,
    archivePath: join(legacyDirectory, 'results.zip'),
    legacy: true,
  };
}

export async function archiveResearchDirectory(researchDirectory: string): Promise<string> {
  const archivePath = join(researchDirectory, 'results.zip');
  const files = await collectArchiveFiles(researchDirectory);
  const entries = await Promise.all(files.map(async (entry) => ({
    name: entry.relativePath.split(sep).join('/'),
    data: await readFile(entry.absolutePath),
  })));
  const zip = buildZip(entries);
  const tempPath = `${archivePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(tempPath, zip);
    await rename(tempPath, archivePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to create archive "${archivePath}". Completed artifacts were preserved.`, { cause: error });
  }
  return archivePath;
}

async function allocateDirectory(parent: string, baseName: string): Promise<string> {
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const name = suffix === 1 ? baseName : `${baseName}-${String(suffix).padStart(2, '0')}`;
    const candidate = join(parent, name);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue;
      if (error instanceof ResearchError) throw error;
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        `Failed to allocate directory "${candidate}".`,
        { cause: error },
      );
    }
  }
  throw new ResearchError('OUTPUT_WRITE_ERROR', `Could not allocate a unique directory for "${baseName}" under "${parent}".`);
}

async function writeIndex(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.tmp-${randomUUID()}`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (error instanceof ResearchError) throw error;
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to write output index "${path}".`, { cause: error });
  }
}

async function readIndex<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to read output index "${path}".`, { cause: error });
  }
}

function assertSafeId(id: string, kind: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Invalid ${kind} ID: ${id}`);
  }
}

function assertIndexedPath(parent: string, child: string): void {
  const rel = relative(resolve(parent), resolve(child));
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Output index points outside its allowed root: ${child}`);
  }
}

async function requireFile(path: string, description: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    throw new ResearchError('RESUME_NOT_FOUND', `${description} not found (missing ${path}).`, { cause: error });
  }
}

async function collectArchiveFiles(root: string): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  const output: Array<{ absolutePath: string; relativePath: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath);
      if (shouldExclude(relativePath, entry.isDirectory())) continue;
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) output.push({ absolutePath, relativePath });
    }
  };
  await visit(root);
  return output.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function shouldExclude(relativePath: string, directory: boolean): boolean {
  const normalized = relativePath.split(sep).join('/');
  const name = normalized.split('/').at(-1) ?? normalized;
  if (directory && (name === 'debug' || name === 'cache' || name === 'browser-profile')) return true;
  return name === 'results.zip'
    || name.includes('.tmp-')
    || name.endsWith('-wal')
    || name.endsWith('-shm')
    || name === '.env'
    || /secret/i.test(name);
}

function buildZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const compressed = deflateRawSync(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function dosDateTime(value: Date): { time: number; date: number } {
  const year = Math.max(1980, value.getFullYear());
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}
