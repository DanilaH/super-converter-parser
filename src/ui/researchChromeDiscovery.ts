import {
  inspectResearchChrome,
  startResearchChrome,
  type ResearchChromeOptions,
  type ResearchChromeStatus,
} from './researchChrome.js';

export type ResearchChromeDiscoveryDeps = {
  inspectResearchChrome: typeof inspectResearchChrome;
  startResearchChrome: typeof startResearchChrome;
};

export type ResearchChromeDiscoveryOptions = {
  env?: NodeJS.ProcessEnv | undefined;
  runtime?: ResearchChromeOptions['runtime'] | undefined;
};

export const DEFAULT_RESEARCH_CHROME_DISCOVERY_DEPS: ResearchChromeDiscoveryDeps = {
  inspectResearchChrome,
  startResearchChrome,
};

export async function ensureResearchChromeForDiscovery(
  options: ResearchChromeDiscoveryOptions = {},
  deps: ResearchChromeDiscoveryDeps = DEFAULT_RESEARCH_CHROME_DISCOVERY_DEPS,
): Promise<ResearchChromeStatus> {
  const chromeOptions = normalizeResearchChromeOptions(options);
  const before = await deps.inspectResearchChrome(chromeOptions);
  if (before.connected) return before;

  // A remote/custom CDP endpoint or a non-Windows host can still be managed outside
  // this personal UI. Do not convert that supported read-only configuration into a
  // new UI failure mode merely because the built-in launcher cannot own it.
  if (!before.controlSupported) return before;

  if (before.profileReady !== true) {
    throw new Error(
      'Research Chrome one-time setup is required before browser-backed discovery. Click "Setup once" in the Runner workspace, then retry.',
    );
  }

  return deps.startResearchChrome(chromeOptions);
}

function normalizeResearchChromeOptions(options: ResearchChromeDiscoveryOptions): ResearchChromeOptions {
  const normalized: ResearchChromeOptions = {};
  if (options.env !== undefined) normalized.env = options.env;
  if (options.runtime !== undefined) normalized.runtime = options.runtime;
  return normalized;
}
