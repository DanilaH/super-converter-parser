const root = document.querySelector('#shortlist-action-root');
const app = document.querySelector('#app');

if (!root || !app) throw new Error('Missing Runner shortlist UI roots.');

let refreshEpoch = 0;
let loadedFor = null;
let scheduled = null;

const observer = new MutationObserver(() => scheduleSync());
observer.observe(app, {
  attributes: true,
  attributeFilter: ['data-research-id', 'data-human-requirement'],
  childList: true,
  subtree: true,
});
window.addEventListener('hashchange', () => {
  refreshEpoch += 1;
  loadedFor = null;
  hideRoot();
  scheduleSync();
});
scheduleSync();

function scheduleSync() {
  if (scheduled !== null) window.clearTimeout(scheduled);
  scheduled = window.setTimeout(() => {
    scheduled = null;
    void syncFromRenderedDetail();
  }, 0);
}

async function syncFromRenderedDetail() {
  const routeResearchId = currentGateResearchId('shortlist');
  if (!routeResearchId) {
    loadedFor = null;
    hideRoot();
    return;
  }
  if (loadedFor === routeResearchId) return;

  const epoch = ++refreshEpoch;
  loadedFor = routeResearchId;
  showLoading();
  try {
    const [payload, jobsPayload] = await Promise.all([
      api(`/api/researches/${encodeURIComponent(routeResearchId)}/shortlist`),
      api('/api/jobs').catch(() => ({ jobs: [] })),
    ]);
    if (epoch !== refreshEpoch) return;
    const activeJob = (jobsPayload.jobs ?? []).find((job) => job.state === 'running') ?? null;
    renderSelector(payload.shortlist, activeJob);
  } catch (error) {
    if (epoch !== refreshEpoch) return;
    loadedFor = null;
    renderGateLoadFailure(error);
  }
}

function currentGateResearchId(expectedRequirement) {
  const routeResearchId = researchIdFromHash();
  const renderedResearchId = app.dataset.researchId ?? null;
  if (!routeResearchId || !renderedResearchId || routeResearchId !== renderedResearchId) return null;
  if (app.dataset.humanRequirement !== expectedRequirement) return null;
  return routeResearchId;
}

function renderSelector(gate, activeJob) {
  showRoot();
  root.replaceChildren();

  const header = document.createElement('div');
  header.className = 'shortlist-header';
  const copy = document.createElement('div');
  copy.className = 'shortlist-copy';
  const eyebrow = document.createElement('div');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'Step · choose shortlist';
  const title = document.createElement('strong');
  title.textContent = 'Choose what to enrich';
  const description = document.createElement('span');
  description.textContent = `Select ${gate.minSelection}–${gate.maxSelection} keywords. Nothing is chosen for you; when you continue, enrichment starts from exactly this selection.`;
  copy.append(eyebrow, title, description);
  header.append(copy);

  const identity = document.createElement('code');
  identity.className = 'shortlist-run-id';
  identity.textContent = gate.discoveryRunId;
  header.append(identity);
  root.append(header);

  const selected = new Set();
  let submitting = false;
  const toolbar = document.createElement('div');
  toolbar.className = 'shortlist-toolbar';

  const search = document.createElement('input');
  search.className = 'control shortlist-search';
  search.type = 'search';
  search.placeholder = 'Filter keywords…';
  search.setAttribute('aria-label', 'Filter shortlist candidates');

  const tier = document.createElement('select');
  tier.className = 'control shortlist-tier';
  tier.setAttribute('aria-label', 'Filter shortlist candidates by tier');
  for (const [value, label] of [['all', 'All tiers'], ['A', 'Tier A'], ['B', 'Tier B'], ['C', 'Tier C'], ['D', 'Tier D'], ['unscored', 'Unscored']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    tier.append(option);
  }

  const selectVisible = document.createElement('button');
  selectVisible.type = 'button';
  selectVisible.className = 'button compact';
  selectVisible.textContent = 'Select filtered';

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'button compact';
  clear.textContent = 'Clear';

  const selectionState = document.createElement('span');
  selectionState.className = 'shortlist-selection-state';
  toolbar.append(search, tier, selectVisible, clear, selectionState);
  root.append(toolbar);

  const tableWrap = document.createElement('div');
  tableWrap.className = 'shortlist-table-wrap';
  const table = document.createElement('table');
  table.className = 'shortlist-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['', 'Keyword', 'Volume', 'Score', 'Tier', 'Organic', 'Median DR', 'Weak', 'Evidence']) {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  tableWrap.append(table);
  root.append(tableWrap);

  const footer = document.createElement('div');
  footer.className = 'shortlist-footer';
  const footerNote = document.createElement('span');
  footerNote.className = 'shortlist-footer-note';
  footerNote.textContent = `${gate.candidateCount} candidates · sorted by existing Runner score/volume semantics. Unscored evidence stays unscored.`;
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'button primary';
  submit.textContent = 'Start enrichment';
  footer.append(footerNote, submit);
  root.append(footer);

  const filtered = () => {
    const query = search.value.trim().toLowerCase();
    const tierValue = tier.value;
    return gate.candidates.filter((candidate) => {
      if (query && !candidate.keyword.toLowerCase().includes(query) && !candidate.normalizedKeyword.includes(query)) return false;
      if (tierValue === 'unscored') return candidate.tier === null;
      if (tierValue !== 'all' && candidate.tier !== tierValue) return false;
      return true;
    });
  };

  const updateState = () => {
    const count = selected.size;
    const blocked = Boolean(activeJob) || submitting;
    selectionState.textContent = `${count} selected`;
    selectionState.classList.toggle('valid', count >= gate.minSelection && count <= gate.maxSelection);
    search.disabled = blocked;
    tier.disabled = blocked;
    submit.disabled = blocked || count < gate.minSelection || count > gate.maxSelection;
    submit.textContent = activeJob
      ? 'Another job is running'
      : submitting
        ? 'Starting enrichment…'
        : count >= gate.minSelection && count <= gate.maxSelection
          ? `Start enrichment with ${count}`
          : `Select ${gate.minSelection}–${gate.maxSelection}`;
    clear.disabled = blocked || count === 0;
  };

  const renderRows = () => {
    tbody.replaceChildren();
    const rows = filtered();
    for (const candidate of rows) {
      const tr = document.createElement('tr');
      if (selected.has(candidate.normalizedKeyword)) tr.classList.add('selected');

      const selectCell = document.createElement('td');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.has(candidate.normalizedKeyword);
      checkbox.disabled = Boolean(activeJob) || submitting || (!checkbox.checked && selected.size >= gate.maxSelection);
      checkbox.setAttribute('aria-label', `Select ${candidate.keyword}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(candidate.normalizedKeyword);
        else selected.delete(candidate.normalizedKeyword);
        renderRows();
        updateState();
      });
      selectCell.append(checkbox);

      tr.append(
        selectCell,
        textCell(candidate.keyword, 'keyword-cell'),
        numberCell(candidate.surferVolume),
        numberCell(candidate.score),
        textCell(candidate.tier ?? '—', candidate.tier ? `tier tier-${candidate.tier.toLowerCase()}` : 'muted-cell'),
        numberCell(candidate.organicResultCount),
        numberCell(candidate.medianDr),
        numberCell(candidate.weakDomainsCount),
        textCell(candidate.scoringCompleteness === 'complete' ? 'Complete' : 'Degraded', candidate.scoringCompleteness === 'complete' ? 'evidence-complete' : 'evidence-degraded'),
      );
      tbody.append(tr);
    }
    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 9;
      td.className = 'shortlist-empty';
      td.textContent = 'No candidates match this filter.';
      tr.append(td);
      tbody.append(tr);
    }
    selectVisible.disabled = Boolean(activeJob) || submitting || rows.length === 0 || selected.size >= gate.maxSelection;
  };

  search.addEventListener('input', renderRows);
  tier.addEventListener('change', renderRows);
  clear.addEventListener('click', () => {
    selected.clear();
    renderRows();
    updateState();
  });
  selectVisible.addEventListener('click', () => {
    let remaining = gate.maxSelection - selected.size;
    for (const candidate of filtered()) {
      if (remaining <= 0) break;
      if (selected.has(candidate.normalizedKeyword)) continue;
      selected.add(candidate.normalizedKeyword);
      remaining -= 1;
    }
    renderRows();
    updateState();
  });

  submit.addEventListener('click', async () => {
    if (submit.disabled) return;
    const keywords = gate.candidates
      .filter((candidate) => selected.has(candidate.normalizedKeyword))
      .map((candidate) => candidate.normalizedKeyword);
    submitting = true;
    renderRows();
    updateState();
    renderSubmitting(root, keywords.length);
    try {
      const payload = await apiMutation(`/api/researches/${encodeURIComponent(gate.researchId)}/shortlist`, {
        version: 1,
        discoveryRunId: gate.discoveryRunId,
        normalizedKeywords: keywords,
      });
      await pollShortlistJob(payload.job.jobId);
    } catch (error) {
      submitting = false;
      renderRows();
      updateState();
      renderFailure(error);
    }
  });

  renderRows();
  updateState();
}

function renderSubmitting(container, count) {
  const existing = container.querySelector('.shortlist-job');
  existing?.remove();
  const panel = document.createElement('div');
  panel.className = 'shortlist-job';
  const strong = document.createElement('strong');
  strong.textContent = `Starting enrichment with ${count} keywords…`;
  const span = document.createElement('span');
  span.textContent = 'Checking the current research state before enrichment starts.';
  panel.append(strong, span);
  container.append(panel);
}

async function pollShortlistJob(jobId) {
  while (true) {
    const payload = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    const job = payload.job;
    renderJob(job);
    if (job.state !== 'running') {
      window.setTimeout(() => {
        loadedFor = null;
        window.dispatchEvent(new Event('hashchange'));
      }, 900);
      return;
    }
    await delay(1000);
  }
}

function renderJob(job) {
  showRoot();
  const old = root.querySelector('.shortlist-job');
  old?.remove();
  const panel = document.createElement('div');
  panel.className = 'shortlist-job';
  const strong = document.createElement('strong');
  const span = document.createElement('span');
  if (job.state === 'running') {
    strong.textContent = 'Enrichment is running';
    span.textContent = 'Your shortlist was accepted. Waiting for the research state to update.';
  } else if (job.state === 'failed') {
    strong.textContent = 'Enrichment did not start';
    span.textContent = `${job.error?.code ?? 'INTERNAL_ERROR'}: ${job.error?.message ?? 'Unknown error'}`;
    panel.classList.add('failed');
  } else {
    strong.textContent = 'Enrichment step finished';
    const result = job.result;
    span.textContent = result?.enrichmentId
      ? `Enrichment ${result.enrichmentId} is recorded. Refreshing the research state.`
      : 'Refreshing the research state.';
    panel.classList.add('finished');
  }
  panel.append(strong, span);
  root.append(panel);
}

function renderGateLoadFailure(error) {
  showRoot();
  root.replaceChildren();
  const panel = document.createElement('div');
  panel.className = 'shortlist-job failed';
  const strong = document.createElement('strong');
  strong.textContent = 'Could not load the shortlist step';
  const span = document.createElement('span');
  span.textContent = error instanceof Error ? error.message : String(error);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button compact';
  retry.textContent = 'Reload current step';
  retry.addEventListener('click', () => {
    loadedFor = null;
    scheduleSync();
  });
  panel.append(strong, span, retry);
  root.append(panel);
}

function renderFailure(error) {
  showRoot();
  const old = root.querySelector('.shortlist-job');
  old?.remove();
  const panel = document.createElement('div');
  panel.className = 'shortlist-job failed';
  const strong = document.createElement('strong');
  strong.textContent = 'Could not start enrichment';
  const span = document.createElement('span');
  span.textContent = `${error instanceof Error ? error.message : String(error)} Your current shortlist is still selected; retry with the main button.`;
  panel.append(strong, span);
  root.append(panel);
}

function textCell(value, className = '') {
  const td = document.createElement('td');
  td.className = className;
  td.textContent = String(value ?? '—');
  return td;
}

function numberCell(value) {
  const td = document.createElement('td');
  td.className = value === null || value === undefined ? 'numeric muted-cell' : 'numeric';
  td.textContent = value === null || value === undefined ? '—' : formatNumber(value);
  return td;
}

function formatNumber(value) {
  if (typeof value !== 'number') return String(value);
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function researchIdFromHash() {
  const hash = window.location.hash;
  if (!hash.startsWith('#/research/')) return null;
  try {
    const decoded = decodeURIComponent(hash.slice('#/research/'.length)).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

async function api(path) {
  return requestJson(path, { headers: { Accept: 'application/json' } });
}

async function apiMutation(path, body) {
  return requestJson(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function requestJson(path, options) {
  const response = await fetch(path, options);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`HTTP ${response.status}: invalid JSON response`);
  }
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  return payload;
}

function showLoading() {
  showRoot();
  root.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'shortlist-loading';
  loading.textContent = 'Loading current shortlist evidence…';
  root.append(loading);
}

function showRoot() {
  root.classList.remove('hidden');
}

function hideRoot() {
  root.classList.add('hidden');
  root.replaceChildren();
}

function humanize(value) {
  return String(value).replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
