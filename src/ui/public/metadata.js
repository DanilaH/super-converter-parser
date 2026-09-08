const root = document.querySelector('#metadata-action-root');

if (!root) throw new Error('Missing Runner metadata UI root.');

let refreshEpoch = 0;
window.addEventListener('hashchange', () => void refreshMetadataAction());
void refreshMetadataAction();

async function refreshMetadataAction() {
  const epoch = ++refreshEpoch;
  hideRoot();
  const researchId = researchIdFromHash();
  if (!researchId) return;

  try {
    const [detail, jobsPayload] = await Promise.all([
      api(`/api/researches/${encodeURIComponent(researchId)}`),
      api('/api/jobs').catch(() => ({ jobs: [] })),
    ]);
    if (epoch !== refreshEpoch) return;
    if (detail.status?.legacy || !detail.container || !detail.status?.researchId) return;
    const active = (jobsPayload.jobs ?? []).find((job) => job.state === 'running') ?? null;
    renderSummary({
      researchId: detail.status.researchId,
      label: detail.status.label,
      activeJob: active,
    });
  } catch {
    if (epoch === refreshEpoch) hideRoot();
  }
}

function renderSummary({ researchId, label, activeJob }) {
  root.classList.remove('hidden');
  root.replaceChildren();

  const copy = document.createElement('div');
  copy.className = 'metadata-copy';
  const key = document.createElement('span');
  key.className = 'metadata-key';
  key.textContent = 'Display label';
  const value = document.createElement('strong');
  value.textContent = label;
  copy.append(key, value);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button compact';
  button.textContent = activeJob ? 'Job running' : 'Rename';
  button.disabled = Boolean(activeJob);
  if (activeJob) button.title = `UI job ${activeJob.jobId} is currently running.`;
  button.addEventListener('click', () => renderEditor(researchId, label));

  root.append(copy, button);
}

function renderEditor(researchId, currentLabel) {
  root.classList.remove('hidden');
  root.replaceChildren();

  const form = document.createElement('form');
  form.className = 'metadata-form';
  const input = document.createElement('input');
  input.className = 'control metadata-input';
  input.type = 'text';
  input.value = currentLabel;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Research display label');

  const state = document.createElement('span');
  state.className = 'metadata-state';
  state.textContent = 'Changes display metadata only; directory and IDs stay unchanged.';

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'button primary compact';
  save.textContent = 'Save';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button compact';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => void refreshMetadataAction());

  form.append(input, state, save, cancel);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const label = input.value.trim();
    if (!label) {
      state.textContent = 'Display label must not be blank.';
      input.focus();
      return;
    }
    input.disabled = true;
    save.disabled = true;
    cancel.disabled = true;
    state.textContent = 'Saving display label…';
    try {
      const payload = await apiMutation(`/api/researches/${encodeURIComponent(researchId)}/label`, { label });
      const warning = payload.rename?.archiveWarning;
      state.textContent = warning
        ? `Label saved. Portable archive refresh warning: ${warning}`
        : payload.rename?.changed === false
          ? 'Label was already current.'
          : 'Label saved.';
      window.setTimeout(() => window.dispatchEvent(new Event('hashchange')), warning ? 1600 : 350);
    } catch (error) {
      input.disabled = false;
      save.disabled = false;
      cancel.disabled = false;
      state.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  root.append(form);
  input.focus();
  input.select();
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
  if (!response.ok) {
    const message = payload?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function hideRoot() {
  root.classList.add('hidden');
  root.replaceChildren();
}
