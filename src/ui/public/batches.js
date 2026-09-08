const root = document.querySelector('#batch-action-root');

if (!root) throw new Error('Missing Runner batch UI root.');

let refreshEpoch = 0;
let refreshTimer = null;
window.addEventListener('hashchange', () => void refreshBatchAction());
void refreshBatchAction();

async function refreshBatchAction() {
  const epoch = ++refreshEpoch;
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  hideRoot();
  const routeResearchId = researchIdFromHash();
  if (!routeResearchId) return;

  try {
    const [catalogPayload, jobsPayload] = await Promise.all([
      api(`/api/researches?q=${encodeURIComponent(routeResearchId)}`),
      api('/api/jobs').catch(() => ({ jobs: [] })),
    ]);
    if (epoch !== refreshEpoch) return;
    const item = (catalogPayload.researches ?? []).find((candidate) =>
      candidate.researchId === routeResearchId
      || (candidate.knownRunIds ?? []).includes(routeResearchId));
    if (!item?.managed || !item.researchId) return;

    const active = (jobsPayload.jobs ?? []).find((job) => job.state === 'running') ?? null;
    const activeBatch = active?.kind === 'append_batch' && active.researchId === item.researchId ? active : null;
    if (activeBatch) {
      renderBatchJob(activeBatch, null);
      void pollBatchJob(activeBatch.jobId, item.researchId, epoch);
      return;
    }
    renderSummary(item.researchId, active);
  } catch {
    if (epoch === refreshEpoch) hideRoot();
  }
}

function renderSummary(researchId, activeJob) {
  showRoot();
  root.replaceChildren();
  const copy = document.createElement('div');
  copy.className = 'batch-copy';
  const title = document.createElement('strong');
  title.textContent = 'Extend research';
  const note = document.createElement('span');
  note.textContent = 'Append explicit seed keywords using the existing research batch/fork semantics.';
  copy.append(title, note);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button compact';
  button.textContent = activeJob ? 'Job running' : 'Add batch';
  button.disabled = Boolean(activeJob);
  if (activeJob) button.title = `UI job ${activeJob.jobId} is currently running.`;
  button.addEventListener('click', () => renderEditor(researchId));
  root.append(copy, button);
}

function renderEditor(researchId) {
  showRoot();
  root.replaceChildren();
  let previewedText = null;
  let currentPlan = null;

  const form = document.createElement('form');
  form.className = 'batch-form';
  const heading = document.createElement('div');
  heading.className = 'batch-form-heading';
  const title = document.createElement('strong');
  title.textContent = 'Add keyword batch';
  const note = document.createElement('span');
  note.textContent = 'One keyword per line. Preview is advisory; commit recomputes counts under the research lock.';
  heading.append(title, note);

  const textarea = document.createElement('textarea');
  textarea.className = 'control batch-textarea';
  textarea.rows = 8;
  textarea.placeholder = 'json formatter\nyaml formatter\n...';
  textarea.setAttribute('aria-label', 'Batch seed keywords');

  const previewBox = document.createElement('div');
  previewBox.className = 'batch-preview muted';
  previewBox.textContent = 'Preview required before append.';

  const state = document.createElement('div');
  state.className = 'batch-state';

  const actions = document.createElement('div');
  actions.className = 'batch-actions';
  const previewButton = document.createElement('button');
  previewButton.type = 'button';
  previewButton.className = 'button compact';
  previewButton.textContent = 'Preview';
  const appendButton = document.createElement('button');
  appendButton.type = 'submit';
  appendButton.className = 'button primary compact';
  appendButton.textContent = 'Append & run discovery';
  appendButton.disabled = true;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button compact';
  cancel.textContent = 'Cancel';
  actions.append(previewButton, appendButton, cancel);

  textarea.addEventListener('input', () => {
    if (previewedText === textarea.value) return;
    previewedText = null;
    currentPlan = null;
    appendButton.disabled = true;
    previewBox.className = 'batch-preview muted';
    previewBox.textContent = 'Preview invalidated by draft changes.';
    state.textContent = '';
  });
  cancel.addEventListener('click', () => void refreshBatchAction());
  previewButton.addEventListener('click', async () => {
    const draft = batchDraft(textarea.value);
    setBusy(true, 'Building read-only batch preview…');
    try {
      const payload = await apiMutation(`/api/researches/${encodeURIComponent(researchId)}/batches/plan`, draft);
      currentPlan = payload.plan;
      previewedText = textarea.value;
      renderPreview(previewBox, currentPlan);
      appendButton.disabled = false;
      state.textContent = currentPlan.changed
        ? 'Commit will fork/currentize discovery as needed, then collect only pending/promoted checkpoints.'
        : 'All normalized inputs are already roots; commit will record the batch without starting discovery.';
    } catch (error) {
      currentPlan = null;
      previewedText = null;
      appendButton.disabled = true;
      previewBox.className = 'batch-preview error-note';
      previewBox.textContent = error instanceof Error ? error.message : String(error);
      state.textContent = '';
    } finally {
      setBusy(false);
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentPlan || previewedText !== textarea.value) {
      appendButton.disabled = true;
      state.textContent = 'Preview the current draft before appending.';
      return;
    }
    setBusy(true, 'Starting authoritative batch append…');
    try {
      const payload = await apiMutation(`/api/researches/${encodeURIComponent(researchId)}/batches`, batchDraft(textarea.value));
      const epoch = ++refreshEpoch;
      renderBatchJob(payload.job, null);
      await pollBatchJob(payload.job.jobId, payload.plan.researchId, epoch);
    } catch (error) {
      setBusy(false);
      state.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  function setBusy(busy, message = '') {
    textarea.disabled = busy;
    previewButton.disabled = busy;
    cancel.disabled = busy;
    appendButton.disabled = busy || !currentPlan || previewedText !== textarea.value;
    if (message) state.textContent = message;
  }

  form.append(heading, textarea, previewBox, state, actions);
  root.append(form);
  textarea.focus();
}

function renderPreview(container, plan) {
  container.className = 'batch-preview';
  container.replaceChildren();
  const metrics = [
    [plan.inputLineCount, 'Supplied lines'],
    [plan.inputUniqueKeywordCount, 'Unique normalized'],
    [plan.addedKeywordCount, 'New'],
    [plan.duplicateKeywordCount, 'Already known'],
    [plan.promotedKeywordCount, 'Promoted roots'],
  ];
  for (const [value, label] of metrics) {
    const item = document.createElement('div');
    const number = document.createElement('strong');
    number.textContent = String(value);
    const caption = document.createElement('span');
    caption.textContent = label;
    item.append(number, caption);
    container.append(item);
  }
  if (plan.promotedNormalizedKeywords?.length) {
    const note = document.createElement('p');
    note.textContent = `Promoted from expansion-only: ${plan.promotedNormalizedKeywords.join(', ')}`;
    container.append(note);
  }
}

async function pollBatchJob(jobId, researchId, epoch) {
  let detail = null;
  let lastDetailAt = 0;
  while (epoch === refreshEpoch) {
    let job;
    try {
      const payload = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
      job = payload.job;
    } catch (error) {
      if (epoch === refreshEpoch) renderFailure(error);
      return;
    }

    if (Date.now() - lastDetailAt > 3000 || job.state !== 'running') {
      try {
        detail = await api(`/api/researches/${encodeURIComponent(researchId)}`);
        lastDetailAt = Date.now();
      } catch {
        // The committed batch/job remains authoritative even if a status refresh races a checkpoint write.
      }
    }
    if (epoch !== refreshEpoch) return;
    renderBatchJob(job, detail);

    if (job.state === 'running') {
      await delay(1000);
      continue;
    }
    refreshTimer = window.setTimeout(() => window.dispatchEvent(new Event('hashchange')), 1000);
    return;
  }
}

function renderBatchJob(job, detail) {
  showRoot();
  root.replaceChildren();
  const copy = document.createElement('div');
  copy.className = 'batch-copy';
  const title = document.createElement('strong');
  const note = document.createElement('span');

  if (job.state === 'running') {
    title.textContent = 'Appending research batch';
    const counts = detail?.status?.discovery?.keywordCounts;
    note.textContent = counts
      ? `Discovery ${detail.status.discovery.state}: ${counts.completed + counts.partial + counts.failed}/${counts.total} terminal · ${counts.pending} pending.`
      : `Job ${job.jobId} is preparing/forking the batch and collecting resulting discovery checkpoints.`;
    copy.append(title, note);
    root.append(copy, statusBadge('Running', 'info'));
    return;
  }

  if (job.state === 'failed') {
    title.textContent = 'Batch append did not complete';
    note.textContent = `${job.error?.code ?? 'INTERNAL_ERROR'}: ${job.error?.message ?? 'Unknown batch error'}`;
    copy.append(title, note);
    root.append(copy, statusBadge('Failed', 'warn'));
    return;
  }

  const result = job.batchResult;
  title.textContent = 'Batch append finished';
  note.textContent = result
    ? result.changed
      ? `${result.batchId}: ${result.addedKeywordCount} new, ${result.promotedKeywordCount} promoted · discovery ${result.discovery.state ?? 'unknown'} (exit ${result.discovery.exitCode}).`
      : `${result.batchId} recorded with no discovery fork; current run remains ${result.currentRunId}.`
    : 'Batch job finished; refreshing canonical research state.';
  copy.append(title, note);
  if (result?.archiveWarning) {
    const warning = document.createElement('span');
    warning.className = 'batch-warning';
    warning.textContent = `Portable archive warning: ${result.archiveWarning}`;
    copy.append(warning);
  }
  root.append(copy, statusBadge('Finished', 'good'));
}

function renderFailure(error) {
  showRoot();
  root.replaceChildren();
  const copy = document.createElement('div');
  copy.className = 'batch-copy';
  const title = document.createElement('strong');
  title.textContent = 'Batch status unavailable';
  const note = document.createElement('span');
  note.textContent = error instanceof Error ? error.message : String(error);
  copy.append(title, note);
  root.append(copy, statusBadge('Error', 'warn'));
}

function statusBadge(text, tone) {
  const badge = document.createElement('span');
  badge.className = `badge ${tone}`;
  badge.textContent = text;
  return badge;
}

function batchDraft(keywords) {
  return { version: 1, keywords };
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
