const root = document.querySelector('#decision-action-root');
const app = document.querySelector('#app');

if (!root || !app) throw new Error('Missing Runner decision UI roots.');

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
  const researchId = currentGateResearchId('human_decisions');
  if (!researchId) {
    loadedFor = null;
    hideRoot();
    return;
  }
  if (loadedFor === researchId) return;

  const epoch = ++refreshEpoch;
  loadedFor = researchId;
  showLoading();
  try {
    const [payload, jobsPayload] = await Promise.all([
      api(`/api/researches/${encodeURIComponent(researchId)}/decisions`),
      api('/api/jobs').catch(() => ({ jobs: [] })),
    ]);
    if (epoch !== refreshEpoch) return;
    const activeJob = (jobsPayload.jobs ?? []).find((job) => job.state === 'running') ?? null;
    renderDecisionGate(payload.decisions, activeJob);
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

function renderDecisionGate(gate, activeJob) {
  showRoot();
  root.replaceChildren();

  const state = new Map(gate.finalists.map((finalist) => [
    finalist.clusterId,
    {
      buildDecision: finalist.currentDecision?.buildDecision ?? null,
      seoProductRole: finalist.currentDecision?.seoProductRole ?? null,
    },
  ]));
  const persisted = snapshotState(state);

  const header = document.createElement('div');
  header.className = 'decision-header';
  const copy = document.createElement('div');
  copy.className = 'decision-copy';
  const eyebrow = document.createElement('div');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'Human gate · decisions';
  const title = document.createElement('strong');
  title.textContent = 'Review finalists and record decisions';
  const description = document.createElement('span');
  description.textContent = 'The Runner does not choose for you. Either field records a human decision; leaving both empty keeps that finalist unresolved. Partial saves remain at this gate.';
  copy.append(eyebrow, title, description);
  header.append(copy);

  const identity = document.createElement('div');
  identity.className = 'decision-identities';
  identity.append(
    idLine('enrichment', gate.enrichmentId),
    idLine('representatives', `rev ${gate.representativeRevision}`),
    idLine('entrant', shortFingerprint(gate.entrantFingerprint)),
  );
  header.append(identity);
  root.append(header);

  const toolbar = document.createElement('div');
  toolbar.className = 'decision-toolbar';
  const search = document.createElement('input');
  search.className = 'control decision-search';
  search.type = 'search';
  search.placeholder = 'Filter finalists, representative queries, flags…';
  search.setAttribute('aria-label', 'Filter finalist decisions');
  const status = document.createElement('span');
  status.className = 'decision-status';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'button compact';
  reset.textContent = 'Reset unsaved';
  toolbar.append(search, status, reset);
  root.append(toolbar);

  const list = document.createElement('div');
  list.className = 'decision-list';
  root.append(list);

  const footer = document.createElement('div');
  footer.className = 'decision-footer';
  const footerNote = document.createElement('span');
  footerNote.className = 'decision-footer-note';
  footerNote.textContent = 'Submitting writes the complete current finalist snapshot through the canonical decisions continuation. No separate UI decision store is used.';
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'button primary';
  footer.append(footerNote, submit);
  root.append(footer);

  const filtered = () => {
    const query = search.value.trim().toLowerCase();
    if (!query) return gate.finalists;
    return gate.finalists.filter((finalist) => {
      const representatives = finalist.evidence?.demand?.representativeQueries ?? [];
      return finalist.clusterId.toLowerCase().includes(query)
        || finalist.canonicalKeyword.toLowerCase().includes(query)
        || representatives.some((item) => String(item.keyword ?? '').toLowerCase().includes(query))
        || (finalist.auditFlags ?? []).some((flag) => String(flag).toLowerCase().includes(query));
    });
  };

  const updateState = () => {
    const decided = decisionCount(state);
    const changed = JSON.stringify(snapshotState(state)) !== JSON.stringify(persisted);
    status.textContent = `${decided}/${gate.finalistCount} recorded${changed ? ' · unsaved changes' : ''}`;
    status.classList.toggle('complete', decided === gate.finalistCount);
    const blocked = Boolean(activeJob);
    submit.disabled = blocked || !changed;
    reset.disabled = blocked || !changed;
    search.disabled = blocked;
    submit.textContent = blocked
      ? 'Another job is running'
      : decided === gate.finalistCount
        ? 'Save & continue to Library'
        : `Save ${decided}/${gate.finalistCount} decisions`;
  };

  const renderRows = () => {
    list.replaceChildren();
    const rows = filtered();
    for (const finalist of rows) {
      list.append(decisionCard(finalist, gate, state, Boolean(activeJob), updateState));
    }
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'decision-empty';
      empty.textContent = 'No finalists match this filter.';
      list.append(empty);
    }
    updateState();
  };

  search.addEventListener('input', renderRows);
  reset.addEventListener('click', () => {
    state.clear();
    for (const item of persisted) {
      state.set(item.clusterId, {
        buildDecision: item.buildDecision,
        seoProductRole: item.seoProductRole,
      });
    }
    renderRows();
  });

  submit.addEventListener('click', async () => {
    if (submit.disabled) return;
    const decisions = gate.finalists.map((finalist) => {
      const current = state.get(finalist.clusterId) ?? { buildDecision: null, seoProductRole: null };
      return {
        clusterId: finalist.clusterId,
        buildDecision: current.buildDecision,
        seoProductRole: current.seoProductRole,
      };
    });
    search.disabled = true;
    reset.disabled = true;
    submit.disabled = true;
    renderSubmitting(decisionCount(state), gate.finalistCount);
    try {
      const payload = await apiMutation(`/api/researches/${encodeURIComponent(gate.researchId)}/decisions`, {
        version: 1,
        discoveryRunId: gate.discoveryRunId,
        enrichmentId: gate.enrichmentId,
        representativeRevision: gate.representativeRevision,
        entrantFingerprint: gate.entrantFingerprint,
        decisionStateUpdatedAt: gate.decisionStateUpdatedAt,
        decisions,
      });
      await pollDecisionJob(payload.job.jobId);
    } catch (error) {
      renderFailure(error);
    }
  });

  renderRows();
}

function decisionCard(finalist, gate, state, blocked, onChange) {
  const card = document.createElement('article');
  card.className = 'decision-card';

  const heading = document.createElement('div');
  heading.className = 'decision-card-heading';
  const title = document.createElement('div');
  title.className = 'decision-card-title';
  const strong = document.createElement('strong');
  strong.textContent = finalist.canonicalKeyword;
  const code = document.createElement('code');
  code.textContent = finalist.clusterId;
  title.append(strong, code);
  heading.append(title);

  const flags = document.createElement('div');
  flags.className = 'decision-flags';
  for (const flag of finalist.auditFlags ?? []) {
    const badge = document.createElement('span');
    badge.textContent = humanize(flag);
    flags.append(badge);
  }
  heading.append(flags);
  card.append(heading);

  const evidence = document.createElement('div');
  evidence.className = 'decision-evidence';
  const demand = finalist.evidence?.demand;
  const serp = finalist.evidence?.serpAccessibility;
  const traffic = finalist.evidence?.organicTrafficProof;
  const repeatability = finalist.evidence?.entrantRepeatability;
  const monetization = finalist.evidence?.monetizationGeography;
  evidence.append(
    metric(formatNumber(demand?.volumeDistribution?.median), 'median volume'),
    metric(formatCoverage(serp?.weakDomainCoverage), 'weak domains'),
    metric(formatCoverage(serp?.repeatedDomainCoverage), 'repeated domains'),
    metric(formatCoverage(serp?.pageIdentityCoverage), 'page identity'),
    metric(formatNumber(traffic?.importedSnapshotCount), 'traffic snapshots'),
    metric(repeatability?.history ? 'yes' : 'no', 'cohort history'),
    metric(formatNumber(monetization?.cpcDistribution?.median), 'median CPC'),
  );
  card.append(evidence);

  const representativeQueries = demand?.representativeQueries ?? [];
  const details = document.createElement('details');
  details.className = 'decision-details';
  const summary = document.createElement('summary');
  summary.textContent = representativeQueries.length > 0
    ? representativeQueries.slice(0, 3).map((item) => item.keyword).join(' · ')
    : 'Evidence details';
  const detailBody = document.createElement('div');
  detailBody.className = 'decision-detail-body';
  detailBody.append(evidenceLine('Representative queries', representativeQueries.map((item) => `${item.keyword} (${formatNumber(item.volume)})`).join(' · ') || 'none'));
  detailBody.append(evidenceLine('SERP warnings', (serp?.warnings ?? []).join(' · ') || 'none'));
  detailBody.append(evidenceLine('Traffic warnings', (traffic?.warnings ?? []).join(' · ') || 'none'));
  detailBody.append(evidenceLine('Product feasibility', (finalist.evidence?.productFeasibility?.warnings ?? []).join(' · ') || 'human review required'));
  details.append(summary, detailBody);
  card.append(details);

  const controls = document.createElement('div');
  controls.className = 'decision-controls';
  const current = state.get(finalist.clusterId) ?? { buildDecision: null, seoProductRole: null };
  const build = selectControl('Build decision', gate.buildDecisionValues, current.buildDecision, blocked);
  const role = selectControl('SEO / product role', gate.seoProductRoleValues, current.seoProductRole, blocked);
  build.select.addEventListener('change', () => {
    const value = state.get(finalist.clusterId) ?? { buildDecision: null, seoProductRole: null };
    value.buildDecision = build.select.value || null;
    state.set(finalist.clusterId, value);
    card.classList.toggle('recorded', Boolean(value.buildDecision || value.seoProductRole));
    onChange();
  });
  role.select.addEventListener('change', () => {
    const value = state.get(finalist.clusterId) ?? { buildDecision: null, seoProductRole: null };
    value.seoProductRole = role.select.value || null;
    state.set(finalist.clusterId, value);
    card.classList.toggle('recorded', Boolean(value.buildDecision || value.seoProductRole));
    onChange();
  });
  controls.append(build.wrapper, role.wrapper);
  card.append(controls);
  card.classList.toggle('recorded', Boolean(current.buildDecision || current.seoProductRole));
  return card;
}

function selectControl(label, values, current, disabled) {
  const wrapper = document.createElement('label');
  wrapper.className = 'decision-field';
  const caption = document.createElement('span');
  caption.textContent = label;
  const select = document.createElement('select');
  select.className = 'control';
  select.disabled = disabled;
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'Unrecorded';
  select.append(blank);
  for (const value of values ?? []) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = humanize(value);
    if (value === current) option.selected = true;
    select.append(option);
  }
  wrapper.append(caption, select);
  return { wrapper, select };
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

function evidenceLine(label, value) {
  const row = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = label;
  const span = document.createElement('span');
  span.textContent = value;
  row.append(strong, span);
  return row;
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

function snapshotState(state) {
  return [...state.entries()]
    .map(([clusterId, value]) => ({ clusterId, buildDecision: value.buildDecision, seoProductRole: value.seoProductRole }))
    .sort((a, b) => a.clusterId.localeCompare(b.clusterId));
}

function decisionCount(state) {
  return [...state.values()].filter((item) => item.buildDecision || item.seoProductRole).length;
}

function formatCoverage(value) {
  if (!value || value.ratio === null || value.ratio === undefined) return '—';
  return `${Math.round(value.ratio * 100)}%`;
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString();
}

function shortFingerprint(value) {
  return typeof value === 'string' && value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-7)}` : String(value ?? '');
}

function humanize(value) {
  return String(value ?? '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderSubmitting(recorded, total) {
  const old = root.querySelector('.decision-job');
  old?.remove();
  const panel = document.createElement('div');
  panel.className = 'decision-job';
  const strong = document.createElement('strong');
  strong.textContent = `Submitting ${recorded}/${total} recorded finalists…`;
  const span = document.createElement('span');
  span.textContent = 'The canonical workflow will revalidate discovery, enrichment, finalist lineage, and persisted decision state under the execution lock.';
  panel.append(strong, span);
  root.append(panel);
}

async function pollDecisionJob(jobId) {
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
  const old = root.querySelector('.decision-job');
  old?.remove();
  const panel = document.createElement('div');
  panel.className = 'decision-job';
  const strong = document.createElement('strong');
  const span = document.createElement('span');
  if (job.state === 'running') {
    strong.textContent = 'Human decisions are being applied';
    span.textContent = `Job ${job.jobId} · canonical finalization owns the submitted snapshot.`;
  } else if (job.state === 'failed') {
    strong.textContent = 'Human-decision continuation failed';
    span.textContent = `${job.error?.code ?? 'INTERNAL_ERROR'}: ${job.error?.message ?? 'Unknown error'}`;
    panel.classList.add('failed');
  } else {
    strong.textContent = 'Human-decision continuation finished';
    const result = job.result;
    span.textContent = result
      ? `Workflow ${humanize(result.workflowState)} · finalization ${humanize(result.finalizationState ?? 'none')} · stop ${humanize(result.stopPoint)}.`
      : 'Workflow job finished; refreshing canonical research state.';
    panel.classList.add('finished');
  }
  panel.append(strong, span);
  root.append(panel);
}

function renderGateLoadFailure(error) {
  showRoot();
  root.replaceChildren();
  const panel = document.createElement('div');
  panel.className = 'decision-job failed';
  const strong = document.createElement('strong');
  strong.textContent = 'Could not load current human-decision gate';
  const span = document.createElement('span');
  span.textContent = error instanceof Error ? error.message : String(error);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button compact';
  retry.textContent = 'Reload current gate';
  retry.addEventListener('click', () => {
    loadedFor = null;
    scheduleSync();
  });
  panel.append(strong, span, retry);
  root.append(panel);
}

function renderFailure(error) {
  showRoot();
  const old = root.querySelector('.decision-job');
  old?.remove();
  const panel = document.createElement('div');
  panel.className = 'decision-job failed';
  const strong = document.createElement('strong');
  strong.textContent = 'Could not save human decisions';
  const span = document.createElement('span');
  span.textContent = error instanceof Error ? error.message : String(error);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button compact';
  retry.textContent = 'Reload current gate';
  retry.addEventListener('click', () => {
    loadedFor = null;
    scheduleSync();
  });
  panel.append(strong, span, retry);
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
  loading.className = 'decision-loading';
  loading.textContent = 'Loading current finalist evidence and persisted decisions…';
  root.append(loading);
}

function showRoot() {
  root.classList.remove('hidden');
}

function hideRoot() {
  root.classList.add('hidden');
  root.replaceChildren();
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
