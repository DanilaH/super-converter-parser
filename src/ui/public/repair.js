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
  showRoot();
  root.replaceChildren();
  const copy = repairCopy(
    'Repair discovery checkpoints',
    `${repairable} checkpoint${repairable === 1 ? '' : 's'} are repairable under the Runner primary-evidence rules. This retries only failed or provably incomplete primary checkpoints and preserves attempt history.`,
    'Explicit specialist action',
  );

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
  showRoot();
  root.replaceChildren(repairCopy(
    'Starting discovery repair…',
    'Canonical eligibility is being revalidated under the research execution lock.',
  ));
}

function renderRunning(job) {
  showRoot();
  root.replaceChildren();
  const copy = repairCopy(
    'Repairing discovery',
    `Job ${job.jobId} is retrying eligible primary checkpoints. Ordinary continuation remains blocked until this job finishes.`,
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
    'Discovery repair finished',
    result
      ? `${result.repairableBefore} → ${result.repairableAfter} repairable checkpoints · discovery ${humanize(result.discoveryState ?? 'unknown')} · exit ${result.exitCode}.`
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
    'Discovery repair did not complete',
    error instanceof Error ? error.message : String(error),
  );
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button';
  retry.textContent = 'Reload current state';
  retry.addEventListener('click', () => void refreshRepairAction());
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
