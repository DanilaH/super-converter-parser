import { readFile } from 'node:fs/promises';

// Scans generated text (artifacts, logs, CSV, JSON, Markdown) for a sentinel
// secret. The Ahrefs API key is only ever held in the process environment and
// passed to the network client; it must never appear in any persisted artifact,
// debug file, or operator log. This module is the automated guard for that
// invariant (see TASK-008 / issue #16, block 6).
export function containsSecret(text: string, sentinel: string): boolean {
  if (!sentinel) return false;
  return text.includes(sentinel);
}

// Scans each file for the sentinel. A missing or unreadable file is treated as
// "nothing leaked there" rather than an error, so a deleted artifact cannot
// masquerade as a leak.
export async function scanFilesForSecret(paths: string[], sentinel: string): Promise<boolean> {
  for (const path of paths) {
    try {
      const content = await readFile(path, 'utf8');
      if (containsSecret(content, sentinel)) return true;
    } catch {
      // File absent or unreadable: no content to leak from.
    }
  }
  return false;
}

// Scans a captured log stream (already joined into one string) for the sentinel.
export function scanTextForSecret(text: string, sentinel: string): boolean {
  return containsSecret(text, sentinel);
}
