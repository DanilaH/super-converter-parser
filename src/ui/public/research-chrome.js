const root = document.querySelector('#research-chrome-root');

if (!root) throw new Error('Missing Research Chrome workspace root.');

let refreshEpoch = 0;
let statusTimer = null;

void refreshStatus();
scheduleRefresh();

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshStatus();
});
window.addEventListener('runner:research-chrome-refresh', () => void refreshStatus());

async function refreshStatus() {
  const epoch = ++refreshEpoch;
  try {
    const payload = await api('/api/system/research-chrome');
    if (epoch !== refreshEpoch) return;
    renderStatus(payload.researchChrome);
  } catch (error) {
    if (epoch === refreshEpoch) renderFailure('Could not inspect Research Chrome', error);
  }
}

function renderStatus(status) {
  root.replaceChildren();
  const card = document.createElement('div');
  card.className = 'workspace-chrome-card';
  const line = document.createElement('div');
  line.className = 'workspace-chrome-line';
  line.append(dot(status.connected ? 'connected' : status.profileReady === false ? 'setup' : 'ready'));
  const title = document.createElement('strong');
  title.textContent = status.connected
    ? 'Research Chrome connected'
    : status.profileReady === false
      ? 'Chrome setup required'
      : 'Research Chrome ready';
  line.append(title);
  card.append(line);

  const detail = document.createElement('div');
  detail.className = 'workspace-chrome-detail';
  if (status.connected) {
    detail.textContent = `${status.browser ?? 'Chrome'} · ${status.endpoint}`;
  } else if (status.configurationError) {
    detail.textContent = status.configurationError;
  } else if (status.controlReason) {
    detail.textContent = status.controlReason;
  } else if (status.profileReady === false) {
    detail.textContent = 'Run the one-time setup here. After that discovery starts Research Chrome automatically when it needs Google.';
  } else {
    detail.textContent = 'Ready. Discovery will start this Chrome automatically when it needs Google.';
  }
  card.append(detail);

  const actions = document.createElement('div');
  actions.className = 'workspace-chrome-actions';
  if (!status.connected && status.controlSupported && status.profileReady === false) {
    const setup = document.createElement('button');
    setup.type = 'button';
    setup.className = 'button compact';
    setup.textContent = 'Setup once';
    setup.addEventListener('click', () => void runSetup());
    actions.append(setup);
  }
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'button compact';
  refresh.textContent = 'Refresh';
  refresh.addEventListener('click', () => void refreshStatus());
  actions.append(refresh);
  card.append(actions);
  root.append(card);
}

async function runSetup() {
  const epoch = ++refreshEpoch;
  renderWorking('Preparing Research Chrome profile…', 'Close regular Chrome first if Windows reports locked profile files.');
  try {
    const payload = await apiMutation('/api/system/research-chrome/setup', {});
    if (epoch !== refreshEpoch) return;
    const status = payload.researchChrome;
    if (status.connected || !status.controlSupported || status.profileReady !== true) {
      renderStatus(status);
      return;
    }
    renderWorking('Setup complete. Starting Research Chrome…', 'The one-time profile setup succeeded. Discovery will also retry browser start automatically when needed.');
    try {
      const started = await apiMutation('/api/system/research-chrome/start', {});
      if (epoch !== refreshEpoch) return;
      renderStatus(started.researchChrome);
    } catch (error) {
      if (epoch === refreshEpoch) renderSetupStartFailure(error);
    }
  } catch (error) {
    if (epoch === refreshEpoch) renderFailure('Research Chrome setup failed', error);
  }
}

function renderSetupStartFailure(error) {
  root.replaceChildren();
  const card = statusCard(
    'error',
    'Setup complete — Chrome did not start',
    `${error instanceof Error ? error.message : String(error)} Discovery will retry the prepared browser automatically when you start or resume discovery.`,
  );
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'button compact';
  refresh.textContent = 'Refresh';
  refresh.addEventListener('click', () => void refreshStatus());
  const actions = document.createElement('div');
  actions.className = 'workspace-chrome-actions';
  actions.append(refresh);
  card.append(actions);
  root.append(card);
}

function renderWorking(titleText, detailText) {
  root.replaceChildren(statusCard('running', titleText, detailText));
}

function renderFailure(title, error) {
  root.replaceChildren();
  const card = statusCard('error', title, error instanceof Error ? error.message : String(error));
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'button compact';
  refresh.textContent = 'Refresh';
  refresh.addEventListener('click', () => void refreshStatus());
  const actions = document.createElement('div');
  actions.className = 'workspace-chrome-actions';
  actions.append(refresh);
  card.append(actions);
  root.append(card);
}

function statusCard(tone, titleText, detailText) {
  const card = document.createElement('div');
  card.className = 'workspace-chrome-card';
  const line = document.createElement('div');
  line.className = 'workspace-chrome-line';
  line.append(dot(tone));
  const title = document.createElement('strong');
  title.textContent = titleText;
  line.append(title);
  const detail = document.createElement('div');
  detail.className = 'workspace-chrome-detail';
  detail.textContent = detailText;
  card.append(line, detail);
  return card;
}

function dot(tone) {
  const element = document.createElement('span');
  element.className = `workspace-dot ${tone}`;
  return element;
}

function scheduleRefresh() {
  if (statusTimer !== null) window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(async () => {
    statusTimer = null;
    if (!document.hidden) await refreshStatus();
    scheduleRefresh();
  }, 8000);
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
