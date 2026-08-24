// First-seen client factory. Selects the provider; returns null when no
// provider is configured (the engine then marks every domain 'unavailable'
// rather than touching a network). Acts as the config preflight for the
// first-seen stage.
import { ResearchError } from '../shared/errors.js';
import { createWaybackClient } from './wayback.js';
import type { FirstSeenClient, FirstSeenClientConfig } from './types.js';

export const FIRST_SEEN_PROVIDERS = ['wayback'] as const;
export type FirstSeenProvider = (typeof FIRST_SEEN_PROVIDERS)[number];

export function parseFirstSeenProvider(value: string | undefined): FirstSeenProvider | null {
  if (value === undefined || value.trim() === '') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'wayback') return 'wayback';
  throw new ResearchError(
    'INPUT_SCHEMA_ERROR',
    `Unknown FIRST_SEEN_PROVIDER "${value}". Known: wayback (or leave blank for unavailable).`,
  );
}

export function createFirstSeenClient(config: FirstSeenClientConfig): FirstSeenClient | null {
  const provider = (config.provider || '').trim().toLowerCase();
  if (provider === '' || provider === 'unconfigured' || provider === 'none') return null;
  if (provider === 'wayback') return createWaybackClient(config);
  throw new ResearchError(
    'INPUT_SCHEMA_ERROR',
    `Unknown first-seen provider: ${config.provider}.`,
  );
}
