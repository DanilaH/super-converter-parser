const app = document.querySelector('#app');

if (!app) throw new Error('Missing Runner app root.');

let refreshEpoch = 0;
let scheduled = null;

const observer = new MutationObserver(() => scheduleSync());
observer.observe(app, { childList: true, subtree: true });
window.addEventListener('hashchange', () => {
  refreshEpoch += 1;
  scheduleSync();
});
scheduleSync();

function scheduleSync() {
  if (scheduled !== null) window.clearTimeout(scheduled);
  scheduled = window.setTimeout(() => {
    scheduled = null;
    void syncSystemCard();
  }, 0);
}

async function syncSystemCard() {
  if (window.location.hash !== '#/system') return;
  const grid = app.querySelector('.system-grid');
  if (!grid || grid.querySelector('[data-research-chrome-card]')) return;

  const card = document.createElement('section');
  card.className = 'panel system-card';
  card.dataset.researchChromeCard = 'true';
  grid.append(card);
  await loadStatus(card);
}

async function loadStatus(card) {
  const epoch = ++refreshEpoch;
  renderLoading(card);
  try {
    const payload = await api('/api/system/research-chrome');
    if (epoch !== refreshEpoch || !card.isConnected || window.location.hash !== '#/system') return;
    renderStatus(card, payload.researchChrome);
  } catch (error) {
    if (epoch !== refreshEpoch || !card.isConnected) return;
    renderFailure(card, 'Could not inspect Research Chrome', error);
  }
}

function renderStatus(card, status) {
  card.replaceChildren();
  card.append(
    node('h2', 'Research Chrome'),
    badge(status.connected ? 'Connected' : 'Not running', status.connected ? 'good' : 'warn'),
    spacer(12),
    kvRow('CDP', status.endpoint),
    kvRow('Browser', status.browser ?? (status.connected ? 'connected' : 'not available')),
    kvRow('Profile', status.profileReady === true ? 'ready' : status.profileReady === false ? 'missing' : 'not managed on this OS'),
    kvRow('Profile root', status.profileRoot),
  );

  if (status.configurationError) {
    card.append(note(status.configurationError, true));
  } else if (status.controlReason) {
    card.append(note(status.controlReason));
  } else if (!status.connected && status.profileReady === false) {
    card.append(note('Setup copies the current Chrome Default profile into the dedicated Research Chrome profile. This is a one-time machine setup.'));
  } else if (!status.connected) {
    card.append(note('The dedicated profile is ready. Start it here before discovery work that needs browser-backed Google / Keyword Surfer evidence.'));
  } else {
    card.append(note('CDP is responding from the configured Research Chrome endpoint.'));
  }

  const actions = document.createElement('div');
  actions.className = 'form-actions';

  if (!status.connected && status.controlSupported) {
    const primary = document.createElement('button');
    primary.type = 'button';
    primary.className = 'button primary';
    const setup = status.profileReady !== true;
    primary.textContent = setup ? 'Setup Research Chrome' : 'Start Research Chrome';
    primary.addEventListener('click', () => void runAction(card, setup ? 'setup' : 'start'));
    actions.append(primary);
  }

  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'button';
  refresh.textContent = 'Refresh status';
  refresh.addEventListener('click', () => void loadStatus(card));
  actions.append(refresh);
  card.append(actions);
}

async function runAction(card, action) {
  const epoch = ++refreshEpoch;
  card.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  card.append(note(action === 'setup' ? 'Preparing the dedicated Research Chrome profile…' : 'Starting Research Chrome and waiting for CDP…'));
  try {
    const payload = await apiMutation(`/api/system/research-chrome/${action}`, {});
    if (epoch !== refreshEpoch || !card.isConnected) return;
    renderStatus(card, payload.researchChrome);
  } catch (error) {
    if (epoch !== refreshEpoch || !card.isConnected) return;
    renderFailure(card, action === 'setup' ? 'Research Chrome setup failed' : 'Research Chrome start failed', error);
  }
}

function renderLoading(card) {
  card.replaceChildren(
    node('h2', 'Research Chrome'),
    node('div', 'Checking CDP and dedicated profile…', 'loading compact-loading'),
  );
}

function renderFailure(card, title, error) {
  card.replaceChildren(
    node('h2', 'Research Chrome'),
    badge('Needs attention', 'warn'),
    note(`${title}: ${error instanceof Error ? error.message : String(error)}`, true),
  );
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button';
  retry.textContent = 'Reload status';
  retry.addEventListener('click', () => void loadStatus(card));
  const actions = document.createElement('div');
  actions.className = 'form-actions';
  actions.append(retry);
  card.append(actions);
}

function kvRow(key, value) {
  const row = document.createElement('div');
  row.className = 'kv-row';
  row.append(node('div', key, 'kv-key'), node('div', value ?? 'n/a', 'kv-value'));
  return row;
}

function note(text, error = false) {
  return node('div', text, `plan-note${error ? ' error-note' : ''}`);
}

function badge(text, tone) {
  return node('span', text, `badge ${tone}`);
}

function spacer(height) {
  const element = document.createElement('div');
  element.setAttribute('style', `height:${height}px`);
  return element;
}

function node(tag, text, className = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = String(text);
  return element;
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
