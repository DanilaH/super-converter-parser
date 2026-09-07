import { inflateRawSync } from 'node:zlib';
import { ResearchError } from '../shared/errors.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const DEFAULT_MAX_ENTRY_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100;

export type ZipReadLimits = {
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
};

export function readFlatZipEntries(
  archive: Buffer,
  limits: ZipReadLimits = {},
): Map<string, Buffer> {
  const maxEntryBytes = limits.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const eocdOffset = findEndOfCentralDirectory(archive);

  const diskNumber = archive.readUInt16LE(eocdOffset + 4);
  const centralDisk = archive.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(eocdOffset + 8);
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw invalidZip('Multi-disk ZIP archives are not supported.');
  }
  if (entryCount > maxEntries) {
    throw invalidZip(`ZIP contains ${entryCount} entries; limit is ${maxEntries}.`);
  }
  if (centralOffset + centralSize > eocdOffset || centralOffset > archive.length) {
    throw invalidZip('ZIP central directory is outside the archive bounds.');
  }

  const output = new Map<string, Buffer>();
  let cursor = centralOffset;
  let totalUncompressedBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    requireRange(archive, cursor, 46, 'central directory header');
    if (archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw invalidZip(`Invalid central directory signature at entry ${index}.`);
    }

    const flags = archive.readUInt16LE(cursor + 8);
    const compressionMethod = archive.readUInt16LE(cursor + 10);
    const expectedCrc32 = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const fileNameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const centralEntrySize = 46 + fileNameLength + extraLength + commentLength;
    requireRange(archive, cursor, centralEntrySize, 'central directory entry');

    if ((flags & 0x0001) !== 0) {
      throw invalidZip('Encrypted ZIP entries are not supported.');
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw invalidZip(`Unsupported ZIP compression method ${compressionMethod}.`);
    }
    if (uncompressedSize > maxEntryBytes) {
      throw invalidZip(`ZIP entry exceeds ${maxEntryBytes} uncompressed bytes.`);
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > maxTotalBytes) {
      throw invalidZip(`ZIP expands beyond the ${maxTotalBytes} byte total limit.`);
    }

    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + fileNameLength);
    const name = nameBytes.toString('utf8');
    if (!isSafeFlatFileName(name)) {
      throw invalidZip(`Unsafe or nested ZIP entry name: ${JSON.stringify(name)}.`);
    }
    if (output.has(name)) {
      throw invalidZip(`Duplicate ZIP entry: ${name}.`);
    }

    requireRange(archive, localHeaderOffset, 30, `local header for ${name}`);
    if (archive.readUInt32LE(localHeaderOffset) !== LOCAL_SIGNATURE) {
      throw invalidZip(`Invalid local header for ${name}.`);
    }
    const localFlags = archive.readUInt16LE(localHeaderOffset + 6);
    const localMethod = archive.readUInt16LE(localHeaderOffset + 8);
    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    const localVariableLength = localNameLength + localExtraLength;
    requireRange(archive, localHeaderOffset + 30, localVariableLength, `local name/extra for ${name}`);

    if (localMethod !== compressionMethod) {
      throw invalidZip(`Compression method mismatch for ${name}.`);
    }
    // The data-descriptor bit is allowed (and used by real Google exports), but
    // central/local identity still has to agree. Otherwise a crafted central
    // directory could label another local payload as a required GSC filename.
    if ((localFlags & 0x0001) !== (flags & 0x0001) || (localFlags & 0x0008) !== (flags & 0x0008)) {
      throw invalidZip(`General-purpose flag mismatch for ${name}.`);
    }
    const localNameBytes = archive.subarray(
      localHeaderOffset + 30,
      localHeaderOffset + 30 + localNameLength,
    );
    if (!localNameBytes.equals(nameBytes)) {
      throw invalidZip(`Local and central filenames differ for ${name}.`);
    }

    const dataOffset = localHeaderOffset + 30 + localVariableLength;
    requireRange(archive, dataOffset, compressedSize, `compressed data for ${name}`);
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);

    let data: Buffer;
    try {
      data = compressionMethod === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: maxEntryBytes });
    } catch (error) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Cannot decompress ZIP entry ${name}.`, { cause: error });
    }
    if (data.length !== uncompressedSize) {
      throw invalidZip(`Uncompressed size mismatch for ${name}.`);
    }
    if (crc32(data) !== expectedCrc32) {
      throw invalidZip(`CRC32 mismatch for ${name}.`);
    }

    output.set(name, data);
    cursor += centralEntrySize;
  }

  if (cursor !== centralOffset + centralSize) {
    throw invalidZip('ZIP central directory size does not match parsed entries.');
  }
  return output;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minimum = 22;
  if (archive.length < minimum) throw invalidZip('Input is too small to be a ZIP archive.');
  const lowerBound = Math.max(0, archive.length - minimum - MAX_ZIP_COMMENT_BYTES);
  for (let offset = archive.length - minimum; offset >= lowerBound; offset -= 1) {
    if (archive.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + minimum + commentLength === archive.length) return offset;
  }
  throw invalidZip('ZIP end-of-central-directory record was not found.');
}

function requireRange(buffer: Buffer, offset: number, length: number, description: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw invalidZip(`ZIP ${description} is outside the archive bounds.`);
  }
}

function isSafeFlatFileName(name: string): boolean {
  return name !== ''
    && !name.includes('/')
    && !name.includes('\\')
    && name !== '.'
    && name !== '..'
    && !name.includes('\0');
}

function invalidZip(message: string): ResearchError {
  return new ResearchError('INPUT_SCHEMA_ERROR', `Invalid GSC ZIP export: ${message}`);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    const tableValue = CRC_TABLE[(crc ^ byte) & 0xff];
    if (tableValue === undefined) throw new Error('CRC table lookup failed.');
    crc = tableValue ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
