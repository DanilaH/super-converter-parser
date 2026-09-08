import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  OUTPUT_ROOT_OVERRIDE_ENV,
  outputLayout,
  resolveCanonicalOutputRoot,
  type OutputLayout,
} from './researchLayout.js';

export type OutputDiagnostics = {
  version: 1;
  canonicalRoot: string;
  configuredBy: 'RESEARCH_OUTPUT_ROOT' | 'home_default';
  layout: OutputLayout;
  overrideEscapeHatchEnabled: boolean;
  rootExists: boolean;
  researchesDirectoryExists: boolean;
  repoLocalLegacyDirectories: string[];
};

const REPO_LOCAL_LEGACY_DIRECTORIES = ['runs', 'enrichments', 'output'] as const;

export async function buildOutputDiagnostics(input: {
  env?: NodeJS.ProcessEnv;
  userHome?: string;
  cwd?: string;
} = {}): Promise<OutputDiagnostics> {
  const env = input.env ?? process.env;
  const root = resolveCanonicalOutputRoot(env, input.userHome);
  const layout = outputLayout(root);
  const cwd = resolve(input.cwd ?? process.cwd());
  const legacyCandidates = REPO_LOCAL_LEGACY_DIRECTORIES.map((name) => join(cwd, name));
  const repoLocalLegacyDirectories: string[] = [];
  for (const candidate of legacyCandidates) {
    if (await exists(candidate)) repoLocalLegacyDirectories.push(candidate);
  }

  return {
    version: 1,
    canonicalRoot: root,
    configuredBy: env.RESEARCH_OUTPUT_ROOT?.trim() ? 'RESEARCH_OUTPUT_ROOT' : 'home_default',
    layout,
    overrideEscapeHatchEnabled: env[OUTPUT_ROOT_OVERRIDE_ENV]?.trim().toLowerCase() === 'true',
    rootExists: await exists(root),
    researchesDirectoryExists: await exists(layout.researches),
    repoLocalLegacyDirectories,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
