export type FormCounts = {
  formCount: number;
  textareaCount: number;
  inputCount: number;
  fileInputCount: number;
  buttonCount: number;
};

export type PageRecord = {
  url: string;
  finalUrl: string;
  redirectCount: number;
  redirectChain: string[];
  httpStatus: number;
  contentType: string | null;
  fetchStatus: 'ok' | 'error' | 'timeout' | 'oversized' | 'non_html' | 'blocked';
  fetchError: string | null;
  fetchedAt: string;
  cacheStatus: 'hit' | 'miss' | 'expired' | 'refreshed' | 'none';
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  canonical: string | null;
  language: string | null;
  wordCount: number | null;
  forms: FormCounts;
  structuredDataTypes: string[];
  sourceKeywords: string[];
  sourcePositions: number[];
};
