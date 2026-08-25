import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadDotEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  logger: (message: string) => void = console.log,
): string | null {
  const envPath = resolve(cwd, '.env');
  if (!existsSync(envPath)) return null;

  let content: string;
  try {
    content = readFileSync(envPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Warning: could not read ${envPath}: ${message}`);
    return null;
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && env[key] === undefined) env[key] = value;
  }

  logger(`Loaded config: ${envPath}`);
  return envPath;
}
