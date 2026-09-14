const root = document.querySelector('#finalist-action-root');
const app = document.querySelector('#app');

if (!root || !app) throw new Error('Missing Runner finalist scope UI roots.');

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
  const routeResearchId = currentGateResearchId('finalist_scope');
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
      api(`/api/researches/${encodeURIComponent(routeResearchId)}/finalist-scope`),
      api('/api/jobs').catch(() => ({ jobs: [] })),
    ]);
    if (epoch !== refreshEpoch) return;
    const activeJob = (jobsPayload.jobs ?? []).find((job) => job.state === 'running') ?? null;
    renderSelector(payload.finalistScope, activeJob);
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
  header.className = 'finalist-header';
  const copy = document.createElement('div');
  copy.className = 'finalist-copy';
  const eyebrow = document.createElement('div');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'Step · finalization scope';
  const title = document.createElement('strong');
  title.textContent = 'Choose what to finalize';
  const description = document.createElement('span');
  description.textContent = 'Choose specific current clusters, or use all of them. Nothing is ranked or preselected for you.';
  copy.append(eyebrow, title, description);
  header.append(copy);

  const identity = document.createElement('div');
  identity.className = 'finalist-identities';
  identity.append(idLine('enrichment', gate.enrichmentId), idLine('discovery', gate.discoveryRunId));
  header.append(identity);
  root.append(header);

  const selected = new Set();
  let submitting = false;
  const toolbar = document.createElement('div');
  toolbar.className = 'finalist-toolbar';

  const search = document.createElement('input');
  search.className = 'control finalist-search';
  search.type = 'search';
  search.placeholder = 'Filter clusters or member keywords…';
  search.setAttribute('aria-label', 'Filter finalist clusters');

  const selectVisible = document.createElement('button');
  selectVisible.type = 'button';
  selectVisible.className = 'button compact';
  selectVisible.textContent = 'Select filtered';

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'button compact';
  clear.textContent = 'Clear';

  const selectionState = document.createElement('span');
  selectionState.className = 'finalist-selection-state';
  toolbar.append(search, selectVisible, clear, selectionState);
  root.append(toolbar);

  const list = document.createElement('div');
  list.className = 'finalist-list';
  root.append(list);

  const footer = document.createElement('div');
  footer.className = 'finalist-footer';
  const footerNote = document.createElement('span');
  footerNote.className = 'finalist-footer-note';
  footerNote.textContent = `${gate.clusterCount} current clusters · displayed in persisted clustering order, not recommendation order.`;
  const buttons = document.createElement('div');
  buttons.className = 'finalist-footer-actions';
  const allButton = document.createElement('button');
  allButton.type = 'button';
  allButton.className = 'button primary';
  allButton.textContent = `Start finalization: all ${gate.clusterCount}`;
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'button primary';
  submit.textContent = 'Start finalization';
  buttons.append(allButton, submit);
  footer.append(footerNote, buttons);
  root.append(footer);

  const filtered = () => {
    const query = search.value.trim().toLowerCase();
    if (!query) return gate.clusters;
    return gate.clusters.filter((cluster) =>
      cluster.clusterId.toLowerCase().includes(query)
      || cluster.canonicalKeyword.toLowerCase().includes(query)
      || cluster.members.some((member) => member.keyword.toLowerCase().includes(query)
        || member.normalizedKeyword.toLowerCase().includes(query))
      || cluster.representativeDomains.some((domain) => domain.toLowerCase().includes(query)));
  };

  const updateState = () => {
    const count = selected.size;
    selectionState.textContent = `${count} selected`;
    selectionState.classList.toggle('valid', count > 0);
    const blocked = Boolean(activeJob) || submitting;
    search.disabled = blocked;
    submit.disabled = blocked || count === 0;
    allButton.disabled = blocked || gate.clusterCount === 0;
    selectVisible.disabled = blocked || filtered().length === 0;
    clear.disabled = blocked || count === 0;
    allButton.className = `button ${count === 0 ? 'primary' : ''}`.trim();
    submit.className = `button ${count > 0 ? 'primary' : ''}`.trim();
    allButton.textContent = activeJob
      ? 'Another job is running'
      : submitting
        ? 'Starting finalization…'
        : `Start finalization: all ${gate.clusterCount}`;
    submit.textContent = activeJob
      ? 'Another job is running'
      : submitting
        ? 'Starting finalization…'
        : `Start finalization: ${count} selected`;
  };

  const renderRows = () => {
    list.replaceChildren();
    const rows = filtered();
    for (const cluster of rows) list.append(clusterCard(cluster, selected, Boolean(activeJob) || submitting, renderRows, updateState));
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'finalist-empty';
      empty.textContent = 'No current clusters match this filter.';
      list.append(empty);
    }
    updateState();
  };

  search.addEventListener('input', renderRows);
  clear.addEventListener('click', () => {
    selected.clear();
    renderRows();
  });
  selectVisible.addEventListener('click', () => {
    for (const cluster of filtered()) selected.add(cluster.clusterId);
    renderRows();
  });

  submit.addEventListener('click', async () => {
    if (submit.disabled) return;
    const clusterIds = gate.clusters
      .filter((cluster) => selected.has(cluster.clusterId))
      .map((cluster) => cluster.clusterId);
    await submitScope(gate, {
      version: 1,
      enrichmentId: gate.enrichmentId,
      mode: 'selected',
      clusterIds,
    }, clusterIds.length);
  });

  allButton.addEventListener('click', async () => {
    if (allButton.disabled) return;
    await submitScope(gate, {
      version: 1,
      enrichmentId: gate.enrichmentId,
      mode: 'all',
    }, gate.clusterCount);
  });

  async function submitScope(currentGate, body, count) {
    submitting = true;
    renderRows();
    updateState();
    renderSubmitting(count, body.mode === 'all');
    try {
      const payload = await apiMutation(`/api/researches/${encodeURIComponent(currentGate.researchId)}/finalist-scope`, body);
      await pollFinalistJob(payload.job.jobId);
    } catch (error) {
      submitting = false;
      renderRows();
      updateState();
      renderFailure(error);
    }
  }

  renderRows();
}

function clusterCard(cluster, selected, blocked, rerender, updateState) {
  const card = document.createElement('article');
  card.className = 'finalist-card';
  if (selected.has(cluster.clusterId)) card.classList.add('selected');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selected.has(cluster.clusterId);
  checkbox.disabled = blocked;
  checkbox.setAttribute('aria-label', `Select finalist cluster ${cluster.canonicalKeyword}`);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selected.add(cluster.clusterId);
    else selected.delete(cluster.clusterId);
    rerender();
    updateState();
  });

  const main = document.createElement('div');
  main.className = 'finalist-card-main';
  const title = document.createElement('div');
  title.className = 'finalist-card-title';
  const strong = document.createElement('strong');
  strong.textContent = cluster.canonicalKeyword;
  const code = document.createElement('code');
  code.textContent = cluster.clusterId;
  title.append(strong, code);

  const metrics = document.createElement('div');
  metrics.className = 'finalist-metrics';
  metrics.append(
    metric(cluster.memberCount, 'members'),
    metric(formatNumber(cluster.medianVolume), 'median volume'),
    metric(formatRatio(cluster.cohesion?.urlJaccardMedian), 'URL cohesion'),
    metric(formatRatio(cluster.cohesion?.domainJaccardMedian), 'domain cohesion'),
  );

  const members = document.createElement('details');
  members.className = 'finalist-members';
  const summary = document.createElement('summary');
  summary.textContent = memberPreview(cluster.members);
  const memberList = document.createElement('div');
  memberList.className = 'finalist-member-list';
  for (const member of cluster.members) {
    const row = document.createElement('div');
    const name = document.createElement('span');
    name.textContent = member.keyword;
    const evidence = document.createElement('span');
    evidence.textContent = `volume ${formatNumber(member.volume)} · SERP ${formatNumber(member.serpSize)}`;
    row.append(name, evidence);
    memberList.append(row);
  }
  members.append(summary, memberList);

  const domains = document.createElement('div');
  domains.className = 'finalist-domains';
  domains.textContent = cluster.representativeDomains.length > 0
    ? `Representative domains: ${cluster.representativeDomains.slice(0, 5).join(', ')}`
    : 'Representative domains: none persisted';

  main.append(title, metrics, members, domains);
  card.append(checkbox, main);
  return card;
}

function metric(value, label) {
  const item = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = value === null || value === undefined ? '—' : String(value);
  const small = document.createElement('small');
  small.textContent = label;
  item.append(strong, small);
  return item;
}

function idLine(label, value) {
  const line = document.createElement('div');
  const span = document.createElement('span');
  span.textContent = label;
  const code = document.createElement('code');
  code.textContent = value;
  line.append(span, code);
  return line;
}

function memberPreview(members) {
  if (!members.length) return 'No members';
  const first = members.slice(0, 3).map((member) => member.keyword).join(' · ');
  return members.length > 3 ? `${first} · +${members.length - 3} more` : first;
}

function renderSubmitting(count, all) {
  const old = root.querySelector('.finalist-job');
  old?.remove();
  const panel = document.createElement('div');
  panel.className = 'finalist-job';
  const strong = document.createElement('strong');
  strong.textContent = all
    ? `Starting finalization with all ${count} clusters…`
    : `Starting finalization with ${count} selected clusters…`;
  const span = document.createElement('span');
  span.textContent = 'Checking the current enrichment and scope before finalization starts.';
  panel.append(strong, span);
  root.append(panel);
}

async function pollFinalistJob(jobId) {
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
  const old = root.querySelector('.finalist-job');
  old?.remove();
  const panel = document.createElement('div');
  panel.className = 'finalist-job';
  const strong = document.createElement('strong');
  const span = document.createElement('span');
  if (job.state === 'running') {
    strong.textContent = 'Finalization is running';
    span.textContent = 'Your scope was accepted. Waiting for the research state to update.';
  } else if (job.state === 'failed') {
    strong.textContent = 'Finalization did not start';
    span.textContent = `${job.error?.code ?? 'INTERNAL_ERROR'}: ${job.error?.message ?? 'Unknown error'}`;
    panel.classList.add('failed');
  } else {
    strong.textContent = 'Finalization step finished';
    const result = job.result;
    span.textContent = result?.finalizationState
      ? `Finalization is ${humanize(result.finalizationState)}. Refreshing the research state.`
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
  panel.className = 'finalist-job failed';
  const strong = document.createElement('strong');
  strong.textContent = 'Could not load the finalization-scope step';
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
  const old = root.querySelector('.finalist-job');
  old?.remove();
  const panel = document.createElement('div');
  panel.className = 'finalist-job failed';
  const strong = document.createElement('strong');
  strong.textContent = 'Could not start finalization';
  const span = document.createElement('span');
  span.textContent = `${error instanceof Error ? error.message : String(error)} Your current cluster selection is still here; retry with the main action.`;
  panel.append(strong, span);
  root.append(panel);
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
  loading.className = 'finalist-loading';
  loading.textContent = 'Loading current clustering evidence…';
  root.append(loading);
}

function showRoot() {
  root.classList.remove('hidden');
}

function hideRoot() {
  root.classList.add('hidden');
  root.replaceChildren();
}

function formatNumber(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number') return String(value);
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatRatio(value) {
  return value === null || value === undefined ? '—' : Number(value).toFixed(2);
}

function humanize(value) {
  return String(value).replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
