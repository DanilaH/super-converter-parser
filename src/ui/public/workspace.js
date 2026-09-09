const listRoot = document.querySelector('#workspace-researches');
const searchInput = document.querySelector('#workspace-search');
const newButton = document.querySelector('#workspace-new');
const systemButton = document.querySelector('#workspace-system');
const jobRoot = document.querySelector('#workspace-job-status');

if (!listRoot || !searchInput || !newButton || !systemButton || !jobRoot) {
  throw new Error('Missing Runner workspace shell.');
}

let catalogEpoch = 0;
let catalogTimer = null;
let searchTimer = null;
let jobTimer = null;
let researches = [];

newButton.addEventListener('click', () => {
  window.location.hash = '#/new';
});
systemButton.addEventListener('click', () => {
  window.location.hash = '#/system';
});
searchInput.addEventListener('input', () => {
  if (searchTimer !== null) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void refreshCatalog(), 140);
});
window.addEventListener('hashchange', () => {
  normalizeLegacyListRoute();
  renderCatalog(researches);
  void refreshCatalog();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    void refreshCatalog();
    void refreshJobs();
  }
});

normalizeLegacyListRoute();
void refreshCatalog();
void refreshJobs();
scheduleCatalogRefresh();
scheduleJobRefresh();

function normalizeLegacyListRoute() {
  if (!window.location.hash || window.location.hash === '#/researches') {
    window.location.hash = '#/new';
  }
}

async function refreshCatalog() {
  const epoch = ++catalogEpoch;
  const query = searchInput.value.trim();
  try {
    const payload = await api(`/api/researches${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    if (epoch !== catalogEpoch) return;
    researches = payload.researches ?? [];
    renderCatalog(researches);
  } catch (error) {
    if (epoch !== catalogEpoch) return;
    listRoot.replaceChildren(messageNode(error instanceof Error ? error.message : String(error), 'workspace-error'));
  }
}

function renderCatalog(items) {
  listRoot.replaceChildren();
  if (items.length === 0) {
    listRoot.append(messageNode(searchInput.value.trim() ? 'No matching researches.' : 'No researches yet.', 'workspace-empty'));
    return;
  }

  const selected = researchIdFromHash();
  for (const research of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-research';
    button.dataset.researchId = research.researchId;
    if (selected && (selected === research.researchId || (research.knownRunIds ?? []).includes(selected))) {
      button.classList.add('active');
    }

    const top = document.createElement('span');
    top.className = 'workspace-research-title';
    top.textContent = research.label || research.researchId;
    const meta = document.createElement('span');
    meta.className = 'workspace-research-meta';
    meta.textContent = `${research.batchCount ?? 0} batches · ${shortId(research.currentRunId ?? research.researchId)}`;
    button.append(top, meta);
    button.addEventListener('click', () => {
      window.location.hash = `#/research/${encodeURIComponent(research.researchId)}`;
    });
    listRoot.append(button);
  }
}

async function refreshJobs() {
  try {
    const payload = await api('/api/jobs');
    const active = (payload.jobs ?? []).find((job) => job.state === 'running') ?? null;
    renderJob(active);
  } catch {
    renderJob(null);
  }
}

function renderJob(job) {
  jobRoot.replaceChildren();
  if (!job) {
    const dot = document.createElement('span');
    dot.className = 'workspace-dot idle';
    jobRoot.append(dot, textNode('Idle'));
    return;
  }
  const dot = document.createElement('span');
  dot.className = 'workspace-dot running';
  const label = humanize(job.kind ?? 'job');
  jobRoot.append(dot, textNode(`${label} running`));
}

function scheduleCatalogRefresh() {
  if (catalogTimer !== null) window.clearTimeout(catalogTimer);
  catalogTimer = window.setTimeout(async () => {
    catalogTimer = null;
    if (!document.hidden) await refreshCatalog();
    scheduleCatalogRefresh();
  }, 5000);
}

function scheduleJobRefresh() {
  if (jobTimer !== null) window.clearTimeout(jobTimer);
  jobTimer = window.setTimeout(async () => {
    jobTimer = null;
    if (!document.hidden) await refreshJobs();
    scheduleJobRefresh();
  }, 1800);
}

function researchIdFromHash() {
  const hash = window.location.hash;
  if (!hash.startsWith('#/research/')) return null;
  try {
    const value = decodeURIComponent(hash.slice('#/research/'.length)).trim();
    return value || null;
  } catch {
    return null;
  }
}

function shortId(value) {
  const text = String(value ?? '');
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-5)}` : text;
}

function humanize(value) {
  return String(value).replaceAll('_', ' ');
}

function messageNode(text, className) {
  const element = document.createElement('div');
  element.className = className;
  element.textContent = text;
  return element;
}

function textNode(text) {
  const element = document.createElement('span');
  element.textContent = text;
  return element;
}

async function api(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`HTTP ${response.status}: invalid JSON response`);
  }
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  return payload;
}
