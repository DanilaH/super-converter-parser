const root = document.querySelector('#repair-action-root');
const app = document.querySelector('#app');

if (!root || !app) throw new Error('Missing Runner repair UI roots.');

let refreshEpoch = 0;
let eligibleResearchId = null;
let refreshTimer = null;

const noteObserver = new MutationObserver(() => syncRepairNote());
noteObserver.observe(app, { childList: true, subtree: true });

window.addEventListener('hashchange', () => void refreshRepairAction());
void refreshRepairAction();

async function refreshRepairAction() {
  const epoch = ++refreshEpoch;
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  eligibleResearchId = null;
  hideRoot();

  const researchId = researchIdFromHash();
  if (!researchId) return;

  try {
    const [detail, jobsPayload] = await Promise.all([
      api(`/api/researches/${encodeURIComponent(researchId)}`),
      api('/api/jobs').catch(() => ({ jobs: [] })),
    ]);
    if (epoch !== refreshEpoch) return;

    const canonicalId = detail.status?.researchId;
    const repairable = Number(detail.status?.discovery?.keywordCounts?.repairable ?? 0);
    const active = (jobsPayload.jobs ?? []).find((job) => job.state === 'running') ?? null;
    const activeRepair = active?.kind === 'repair_discovery' && active.researchId === canonicalId ? active : null;

    if (activeRepair) {
      eligibleResearchId = canonicalId;
      syncRepairNote();
      renderRunning(activeRepair);
      void pollRepairJob(activeRepair.jobId, epoch);
      return;
    }

    if (detail.status?.nextAction?.code !== 'repair_discovery' || repairable <= 0 || !canonicalId) {
      syncRepairNote();
      return;
    }

    eligibleResearchId = canonicalId;
    syncRepairNote();
    renderEligible({
      researchId: canonicalId,
      repairable,
      activeJob: active,
    });
  } catch {
    if (epoch === refreshEpoch) hideRoot();
  }
}

function renderEligible({ researchId, repairable, activeJob }) {
  root.classList.remove('hidden');
  root.replaceChildren();

  const copy = document.createElement('div');
  copy.className = 'repair-copy';
  const eyebrow = document.createElement('div');
  eyebrow.className = 'eyebrow repair-eyebrow';
  eyebrow.textContent = 'Explicit specialist action';
  const title = document.createElement('strong');
  title.textContent = 'Repair discovery checkpoints';
  const description = document.createElement('span');
  description.textContent = `${repairable} checkpoint${repairable === 1 ? '' : 's'} are repairable under the Runner primary-evidence rules. This retries only failed or provably incomplete primary checkpoints and preserves attempt history.`;
  copy.append(eyebrow, title, description);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button repair-button';
  button.textContent = activeJob ? 'Another job is running' : `Repair ${repairable}`;
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
  root.classList.remove('hidden');
  root.replaceChildren();
  const copy = document.createElement('div');
  copy.className = 'repair-copy';
  const title = document.createElement('strong');
  title.textContent = 'Starting discovery repair…';
  const description = document.createElement('span');
  description.textContent = 'Canonical eligibility is being revalidated under the research execution lock.';
  copy.append(title, description);
  root.append(copy);
}

function renderRunning(job) {
  root.classList.remove('hidden');
  root.replaceChildren();
  const copy = document.createElement('div');
  copy.className = 'repair-copy';
  const title = document.createElement('strong');
  title.textContent = 'Repairing discovery';
  const description = document.createElement('span');
  description.textContent = `Job ${job.jobId} is retrying eligible primary checkpoints. Ordinary continuation remains blocked until this job finishes.`;
  copy.append(title, description);
  const badge = document.createElement('span');
  badge.className = 'badge info';
  badge.textContent = 'Running';
  root.append(copy, badge);
}

function renderFinished(job) {
  root.classList.remove('hidden');
  root.replaceChildren();
  const result = job.repairResult;
  const copy = document.createElement('div');
  copy.className = 'repair-copy';
  const title = document.createElement('strong');
  title.textContent = 'Discovery repair finished';
  const description = document.createElement('span');
  description.textContent = result
    ? `${result.repairableBefore} → ${result.repairableAfter} repairable checkpoints · discovery ${humanize(result.discoveryState ?? 'unknown')} · exit ${result.exitCode}.`
    : 'Repair job finished; refreshing canonical research state.';
  copy.append(title, description);
  const badge = document.createElement('span');
  badge.className = 'badge good';
  badge.textContent = 'Finished';
  root.append(copy, badge);
}

function renderFailure(error) {
  root.classList.remove('hidden');
  root.replaceChildren();
  const copy = document.createElement('div');
  copy.className = 'repair-copy';
  const title = document.createElement('strong');
  title.textContent = 'Discovery repair did not complete';
  const description = document.createElement('span');
  description.textContent = error instanceof Error ? error.message : String(error);
  copy.append(title, description);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button';
  retry.textContent = 'Reload current state';
  retry.addEventListener('click', () => void refreshRepairAction());
  root.append(copy, retry);
}

function syncRepairNote() {
  const note = app.querySelector('.next-action .action-note');
  if (!note) return;
  if (eligibleResearchId && /Repair remains explicit/.test(note.textContent ?? '')) {
    note.textContent = 'Explicit retry-failed repair is available in the specialist action above; it remains separate from ordinary Continue.';
  }
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
