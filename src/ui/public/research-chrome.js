const root = document.querySelector('#research-chrome-root');

if (!root) throw new Error('Missing Research Chrome workspace root.');

let refreshEpoch = 0;
let autoStartAttempted = false;
let statusTimer = null;

void refreshStatus({ autoStart: true });
scheduleRefresh();

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshStatus({ autoStart: false });
});

async function refreshStatus(options = { autoStart: false }) {
  const epoch = ++refreshEpoch;
  renderChecking();
  try {
    const payload = await api('/api/system/research-chrome');
    if (epoch !== refreshEpoch) return;
    const status = payload.researchChrome;

    if (
      options.autoStart
      && !autoStartAttempted
      && !status.connected
      && status.profileReady === true
      && status.controlSupported
      && !status.configurationError
    ) {
      autoStartAttempted = true;
      await startAutomatically(epoch);
      return;
    }
    renderStatus(status);
  } catch (error) {
    if (epoch === refreshEpoch) renderFailure('Could not inspect Research Chrome', error);
  }
}

async function startAutomatically(epoch) {
  renderStarting('Starting Research Chrome automatically…');
  try {
    const payload = await apiMutation('/api/system/research-chrome/start', {});
    if (epoch !== refreshEpoch) return;
    renderStatus(payload.researchChrome);
  } catch (error) {
    if (epoch === refreshEpoch) renderFailure('Automatic Research Chrome start failed', error, true);
  }
}

function renderStatus(status) {
  root.replaceChildren();
  const card = document.createElement('div');
  card.className = 'workspace-chrome-card';
  const line = document.createElement('div');
  line.className = 'workspace-chrome-line';
  line.append(dot(status.connected ? 'connected' : status.profileReady === false ? 'setup' : 'starting'));
  const title = document.createElement('strong');
  title.textContent = status.connected ? 'Research Chrome connected' : status.profileReady === false ? 'Chrome setup required' : 'Research Chrome offline';
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
    detail.textContent = 'One-time setup copies your Chrome Default profile. Close regular Chrome first if Windows reports locked files.';
  } else {
    detail.textContent = `Ready profile · ${status.endpoint}`;
  }
  card.append(detail);

  const actions = document.createElement('div');
  actions.className = 'workspace-chrome-actions';
  if (!status.connected && status.controlSupported) {
    const primary = document.createElement('button');
    primary.type = 'button';
    primary.className = 'button compact';
    const setup = status.profileReady !== true;
    primary.textContent = setup ? 'Setup once' : 'Start Chrome';
    primary.addEventListener('click', () => void runManualAction(setup ? 'setup' : 'start'));
    actions.append(primary);
  }
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'button compact';
  refresh.textContent = 'Refresh';
  refresh.addEventListener('click', () => void refreshStatus({ autoStart: false }));
  actions.append(refresh);
  card.append(actions);
  root.append(card);
}

async function runManualAction(action) {
  const epoch = ++refreshEpoch;
  renderStarting(action === 'setup' ? 'Preparing Research Chrome profile…' : 'Starting Research Chrome…');
  try {
    let payload = await apiMutation(`/api/system/research-chrome/${action}`, {});
    if (epoch !== refreshEpoch) return;
    if (action === 'setup' && payload.researchChrome.profileReady === true && !payload.researchChrome.connected) {
      renderStarting('Profile ready. Starting Research Chrome…');
      payload = await apiMutation('/api/system/research-chrome/start', {});
      if (epoch !== refreshEpoch) return;
    }
    autoStartAttempted = true;
    renderStatus(payload.researchChrome);
  } catch (error) {
    if (epoch === refreshEpoch) renderFailure(action === 'setup' ? 'Research Chrome setup failed' : 'Research Chrome start failed', error, action === 'start');
  }
}

function renderChecking() {
  root.replaceChildren(statusCard('starting', 'Checking Research Chrome…', 'Reading live CDP/profile status.'));
}

function renderStarting(message) {
  root.replaceChildren(statusCard('starting', message, 'No terminal command is needed.'));
}

function renderFailure(title, error, offerStart = false) {
  root.replaceChildren();
  const card = statusCard('error', title, error instanceof Error ? error.message : String(error));
  const actions = document.createElement('div');
  actions.className = 'workspace-chrome-actions';
  if (offerStart) {
    const retryStart = document.createElement('button');
    retryStart.type = 'button';
    retryStart.className = 'button compact';
    retryStart.textContent = 'Retry start';
    retryStart.addEventListener('click', () => void runManualAction('start'));
    actions.append(retryStart);
  }
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'button compact';
  refresh.textContent = 'Refresh';
  refresh.addEventListener('click', () => void refreshStatus({ autoStart: false }));
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
    if (!document.hidden) await refreshStatus({ autoStart: false });
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
