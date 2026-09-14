const root = document.querySelector('#repair-action-root');
const app = document.querySelector('#app');

if (!root || !app) throw new Error('Missing Runner repair UI roots.');

root.classList.add('panel');
Object.assign(root.style, {
  width: 'min(1180px, calc(100% - 64px))',
  margin: '24px auto -18px',
  padding: '16px 18px',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '18px',
});

let refreshEpoch = 0;
let refreshTimer = null;
let syncTimer = null;

const stateObserver = new MutationObserver(() => scheduleRefresh());
stateObserver.observe(app, {
  attributes: true,
  attributeFilter: ['data-research-id', 'data-next-action-code', 'data-repairable'],
  childList: true,
  subtree: true,
});

window.addEventListener('hashchange', () => scheduleRefresh());
scheduleRefresh();

function scheduleRefresh() {
  if (syncTimer !== null) window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    void refreshRepairAction();
  }, 0);
}

async function refreshRepairAction() {
  const epoch = ++refreshEpoch;
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  hideRoot();

  const researchId = researchIdFromHash();
  const canonicalId = app.dataset.researchId ?? null;
  if (!researchId || !canonicalId || researchId !== canonicalId) return;

  const repairable = Number(app.dataset.repairable ?? 0);
  if (app.dataset.nextActionCode !== 'repair_discovery' || !Number.isFinite(repairable) || repairable <= 0) return;

  const jobsPayload = await api('/api/jobs').catch(() => ({ jobs: [] }));
  if (epoch !== refreshEpoch) return;
  const active = (jobsPayload.jobs ?? []).find((job) => job.state === 'running') ?? null;
  const activeRepair = active?.kind === 'repair_discovery' && active.researchId === canonicalId ? active : null;

  if (activeRepair) {
    renderRunning(activeRepair);
    void pollRepairJob(activeRepair.jobId, epoch);
    return;
  }

  renderEligible({
    researchId: canonicalId,
    repairable,
    activeJob: active,
  });
}

function renderEligible({ researchId, repairable, activeJob }) {
  showRoot();
  root.replaceChildren();
  const copy = repairCopy(
    'Retry discovery',
    `${repairable} discovery check${repairable === 1 ? '' : 's'} need another attempt. Retry only those checks; completed work stays intact.`,
    'Discovery needs attention',
  );

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button repair-button';
  button.textContent = activeJob ? 'Another job is running' : `Retry ${repairable}`;
  button.disabled = Boolean(activeJob);
  if (activeJob) button.title = `UI job ${activeJob.jobId} is already running.`;
  button.addEventListener('click', () => void startRepair(researchId));

  root.append(copy, button);
}

async function startRepair(researchId) {
  const epoch = ++refreshEpoch;
  renderStarting();
  try {
    const payload = await apiMutation(`/api/researches/${encodeURIComponent(researchId)}/repair-discovery`, {});
    if (epoch !== refreshEpoch) return;
    renderRunning(payload.job);
    await pollRepairJob(payload.job.jobId, epoch);
  } catch (error) {
    if (epoch !== refreshEpoch) return;
    renderFailure(error);
  }
}

async function pollRepairJob(jobId, epoch) {
  while (epoch === refreshEpoch) {
    let job;
    try {
      const payload = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
      job = payload.job;
    } catch (error) {
      if (epoch === refreshEpoch) renderFailure(error);
      return;
    }
    if (epoch !== refreshEpoch) return;

    if (job.state === 'running') {
      renderRunning(job);
      await delay(1000);
      continue;
    }
    if (job.state === 'failed') {
      renderFailure(new Error(`${job.error?.code ?? 'INTERNAL_ERROR'}: ${job.error?.message ?? 'Discovery repair failed.'}`));
      return;
    }

    renderFinished(job);
    refreshTimer = window.setTimeout(() => {
      window.dispatchEvent(new Event('hashchange'));
    }, 900);
    return;
  }
}

function renderStarting() {
  showRoot();
  root.replaceChildren(repairCopy(
    'Starting discovery retry…',
    'Checking the current research state before retrying the failed discovery checks.',
  ));
}

function renderRunning(job) {
  showRoot();
  root.replaceChildren();
  const copy = repairCopy(
    'Retrying discovery',
    'Retrying the discovery checks that still need attention. You can continue when this finishes.',
  );
  const state = document.createElement('span');
  state.className = 'badge info';
  state.textContent = 'Running';
  root.append(copy, state);
}

function renderFinished(job) {
  showRoot();
  root.replaceChildren();
  const result = job.repairResult;
  const copy = repairCopy(
    'Discovery retry finished',
    result
      ? `${result.repairableBefore} retried · ${result.repairableAfter} still need attention · discovery ${humanize(result.discoveryState ?? 'unknown')}.`
      : 'Repair job finished; refreshing canonical research state.',
  );
  const state = document.createElement('span');
  state.className = 'badge good';
  state.textContent = 'Finished';
  root.append(copy, state);
}

function renderFailure(error) {
  showRoot();
  root.replaceChildren();
  const copy = repairCopy(
    'Discovery retry did not complete',
    error instanceof Error ? error.message : String(error),
  );
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button';
  retry.textContent = 'Try again';
  retry.addEventListener('click', () => scheduleRefresh());
  root.append(copy, retry);
}

function repairCopy(titleText, descriptionText, eyebrowText = null) {
  const copy = document.createElement('div');
  copy.style.minWidth = '0';
  copy.style.maxWidth = '850px';
  if (eyebrowText) {
    const eyebrow = document.createElement('div');
    eyebrow.className = 'eyebrow';
    eyebrow.style.marginBottom = '5px';
    eyebrow.textContent = eyebrowText;
    copy.append(eyebrow);
  }
  const title = document.createElement('strong');
  title.style.display = 'block';
  title.style.fontSize = '14px';
  title.textContent = titleText;
  const description = document.createElement('span');
  description.style.display = 'block';
  description.style.marginTop = '5px';
  description.style.color = '#9fa8b8';
  description.style.fontSize = '13px';
  description.style.lineHeight = '1.45';
  description.textContent = descriptionText;
  copy.append(title, description);
  return copy;
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
  root.style.display = 'flex';
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
