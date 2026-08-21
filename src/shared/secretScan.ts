import { readFile } from 'node:fs/promises';

// Scans generated text (artifacts, run DB, cache DB, debug files, logs) for a
// sentinel secret. The Ahrefs API key is only ever held in the process
// environment and passed to the network client; it must never appear in any
// persisted artifact, debug file, database, or operator log. This module is
// the automated guard for that invariant (see TASK-008 / issue #16, block 6).
export function containsSecret(text: string, sentinel: string): boolean {
  if (!sentinel) return false;
  return text.includes(sentinel);
}

// Scans each EXPECTED file for the sentinel. A missing or unreadable file is
// treated as a FAILED check (throws), never as "safe": an artifact we expect to
// verify but cannot read must surface, not be silently skipped. The caller is
// responsible for listing only files that should exist for the given run.
export async function scanFilesForSecret(paths: string[], sentinel: string): Promise<boolean> {
  for (const path of paths) {
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      throw new Error(
        `Expected artifact "${path}" is missing or unreadable and cannot be verified for secret leakage: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (containsSecret(content, sentinel)) return true;
  }
  return false;
}

// Scans a captured log stream (already joined into one string) for the sentinel.
export function scanTextForSecret(text: string, sentinel: string): boolean {
  return containsSecret(text, sentinel);
}
