import { access, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export type LibraryDerivedSnapshotHealth = {
  current: boolean;
  jsonCurrent: boolean;
  archiveCurrent: boolean;
  warning: string | null;
};

type PublicationProjection = {
  publicationId: string;
  snapshotFingerprint: string;
  supersedesPublicationId: string | null;
  archivePath: string;
};

type PublicationRow = {
  publication_id: string;
  snapshot_fingerprint: string;
  supersedes_publication_id: string | null;
  archive_relative_path: string;
};

type ZipCentralEntry = {
  name: string;
  crc32: number;
  sizeBytes: number;
};

export async function inspectResearchLibraryDerivedSnapshots(
  outputRoot: string,
): Promise<LibraryDerivedSnapshotHealth> {
  const libraryDirectory = join(outputRoot, 'research-library');
  const dbPath = join(libraryDirectory, 'library.sqlite');
  const jsonPath = join(libraryDirectory, 'library.json');
  const archivePath = join(libraryDirectory, 'library.zip');
  const warnings: string[] = [];

  let rows: PublicationProjection[];
  try {
    rows = readPublicationProjection(dbPath);
  } catch (error) {
    return unhealthy(`cannot inspect durable library.sqlite: ${message(error)}`);
  }

  let jsonData: Buffer | null = null;
  let jsonCurrent = false;
  try {
    jsonData = await readFile(jsonPath);
    jsonCurrent = libraryJsonMatches(jsonData, rows);
    if (!jsonCurrent) warnings.push('library.json does not match durable library.sqlite publication lineage');
  } catch (error) {
    warnings.push(`library.json unavailable: ${message(error)}`);
  }

  for (const row of rows) {
    try {
      await access(join(libraryDirectory, row.archivePath));
    } catch (error) {
      warnings.push(`publication archive unavailable: ${row.archivePath} (${message(error)})`);
    }
  }

  let archiveCurrent = false;
  try {
    const entries = await readZipCentralDirectory(archivePath);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const dbData = await readFile(dbPath);
    const requiredNames = ['library.sqlite', 'library.json', ...rows.map((row) => row.archivePath)];
    const missing = requiredNames.filter((name) => !byName.has(name));
    if (missing.length > 0) {
      warnings.push(`library.zip is missing ${missing.join(', ')}`);
    } else if (jsonData === null) {
      warnings.push('library.zip cannot be verified because current library.json is unavailable');
    } else {
      const zippedDb = byName.get('library.sqlite')!;
      const zippedJson = byName.get('library.json')!;
      archiveCurrent = matchesEntry(zippedDb, dbData) && matchesEntry(zippedJson, jsonData);
      if (!archiveCurrent) {
        warnings.push('library.zip embeds stale library.sqlite or library.json bytes');
      }
    }
  } catch (error) {
    warnings.push(`library.zip unavailable or invalid: ${message(error)}`);
  }

  return {
    current: jsonCurrent && archiveCurrent && warnings.length === 0,
    jsonCurrent,
    archiveCurrent,
    warning: warnings.length === 0 ? null : warnings.join('; '),
  };
}

function readPublicationProjection(dbPath: string): PublicationProjection[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`
      SELECT publication_id, snapshot_fingerprint, supersedes_publication_id, archive_relative_path
      FROM publications
      ORDER BY published_at ASC, rowid ASC
    `).all() as PublicationRow[];
    return rows.map((row) => ({
      publicationId: row.publication_id,
      snapshotFingerprint: row.snapshot_fingerprint,
      supersedesPublicationId: row.supersedes_publication_id,
      archivePath: row.archive_relative_path.replaceAll('\\', '/'),
    }));
  } finally {
    db.close();
  }
}

function libraryJsonMatches(data: Buffer, expected: PublicationProjection[]): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf8')) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  if (parsed.publicationCount !== expected.length || !Array.isArray(parsed.publications)) return false;
  if (parsed.publications.length !== expected.length) return false;

  return expected.every((row, index) => {
    const item = parsed.publications[index];
    if (!isRecord(item)) return false;
    return item.publicationId === row.publicationId
      && item.snapshotFingerprint === row.snapshotFingerprint
      && (item.supersedesPublicationId ?? null) === row.supersedesPublicationId
      && item.archivePath === row.archivePath;
  });
}

function matchesEntry(entry: ZipCentralEntry, current: Buffer): boolean {
  return entry.sizeBytes === current.length && entry.crc32 === crc32(current);
}

async function readZipCentralDirectory(path: string): Promise<ZipCentralEntry[]> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size < 22) throw new Error('ZIP is shorter than the end-of-central-directory record');

    const end = Buffer.alloc(22);
    await readExactly(handle, end, stat.size - 22);
    if (end.readUInt32LE(0) !== 0x06054b50) throw new Error('ZIP end-of-central-directory signature is missing');
    if (end.readUInt16LE(20) !== 0) throw new Error('ZIP comments are unsupported for the library snapshot');

    const entryCount = end.readUInt16LE(10);
    const centralSize = end.readUInt32LE(12);
    const centralOffset = end.readUInt32LE(16);
    if (centralOffset + centralSize > stat.size - 22) throw new Error('ZIP central directory points outside the archive');

    const central = Buffer.alloc(centralSize);
    await readExactly(handle, central, centralOffset);
    const entries: ZipCentralEntry[] = [];
    let offset = 0;
    while (offset < central.length) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) {
        throw new Error('Invalid ZIP central-directory entry');
      }
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const next = offset + 46 + nameLength + extraLength + commentLength;
      if (next > central.length) throw new Error('Truncated ZIP central-directory entry');
      entries.push({
        name: central.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
        crc32: central.readUInt32LE(offset + 16),
        sizeBytes: central.readUInt32LE(offset + 24),
      });
      offset = next;
    }
    if (entries.length !== entryCount) {
      throw new Error(`ZIP central directory declares ${entryCount} entries but contains ${entries.length}`);
    }
    return entries;
  } finally {
    await handle.close();
  }
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) throw new Error('Unexpected end of file');
    offset += bytesRead;
  }
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function unhealthy(warning: string): LibraryDerivedSnapshotHealth {
  return { current: false, jsonCurrent: false, archiveCurrent: false, warning };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
