const app = document.querySelector('#app');
const navLinks = [...document.querySelectorAll('[data-nav]')];

if (!app) throw new Error('Missing #app root.');

window.addEventListener('hashchange', () => void route());
void route();

async function route() {
  const hash = window.location.hash || '#/researches';
  setActiveNav(hash.startsWith('#/system') ? 'system' : 'researches');

  if (hash === '#/system') {
    await renderSystem();
    return;
  }

  if (hash.startsWith('#/research/')) {
    const id = decodeURIComponent(hash.slice('#/research/'.length));
    await renderResearchDetail(id);
    return;
  }

  if (hash !== '#/researches') window.location.hash = '#/researches';
  await renderResearchList();
}

function setActiveNav(name) {
  for (const link of navLinks) link.classList.toggle('active', link.dataset.nav === name);
}

async function renderResearchList() {
  app.replaceChildren(pageHeader('Researches', 'Browse durable researches from the canonical Runner output root.'));

  const toolbar = node('div', { className: 'toolbar' });
  const search = node('input', {
    className: 'search',
    type: 'search',
    placeholder: 'Search by name, researchId, or runId…',
    ariaLabel: 'Search researches',
  });
  toolbar.append(search);
  app.append(toolbar);

  const list = node('div', { className: 'panel research-list' });
  list.append(node('div', { className: 'loading', text: 'Loading researches…' }));
  app.append(list);

  let timer = null;
  const load = async () => {
    try {
      const query = search.value.trim();
      const payload = await api(`/api/researches${query ? `?q=${encodeURIComponent(query)}` : ''}`);
      renderResearchRows(list, payload.researches ?? []);
    } catch (error) {
      renderError(list, error);
    }
  };

  search.addEventListener('input', () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => void load(), 160);
  });
  await load();
}

function renderResearchRows(container, researches) {
  container.replaceChildren();
  if (researches.length === 0) {
    container.append(node('div', { className: 'empty', text: 'No researches found.' }));
    return;
  }

  for (const research of researches) {
    const row = node('div', { className: 'research-row' });

    const identity = node('div');
    identity.append(
      node('div', { className: 'research-title', text: research.label }),
      node('div', { className: 'research-meta', text: research.researchId }),
    );

    const current = cell('Current run', research.currentRunId);
    const batches = cell('Batches', String(research.batchCount));
    const updated = cell('Updated', research.updatedAt ? formatDate(research.updatedAt) : 'legacy');
    updated.classList.add('updated-cell');

    const actions = node('div');
    const open = node('button', { className: 'button compact', type: 'button', text: 'Open' });
    open.addEventListener('click', () => {
      window.location.hash = `#/research/${encodeURIComponent(research.researchId)}`;
    });
    actions.append(open);

    row.append(identity, current, batches, updated, actions);
    container.append(row);
  }
}

async function renderResearchDetail(researchId) {
  app.replaceChildren(node('div', { className: 'loading', text: 'Loading research…' }));
  try {
    const detail = await api(`/api/researches/${encodeURIComponent(researchId)}`);
    const { status, container, operatorConfig } = detail;
    app.replaceChildren();

    const top = node('div', { className: 'detail-top' });
    const back = node('a', { className: 'back-link', href: '#/researches', text: '← Researches' });
    const layoutBadge = badge(status.legacy ? 'Legacy layout' : 'Managed research', status.legacy ? 'warn' : 'info');
    top.append(back, layoutBadge);
    app.append(top);

    const header = node('div', { className: 'page-header' });
    const titleBlock = node('div');
    titleBlock.append(
      node('div', { className: 'eyebrow', text: 'Research' }),
      node('h1', { text: status.label }),
      node('p', { text: summaryLine(status, container) }),
    );
    header.append(titleBlock);
    app.append(header);

    const ids = node('div', { className: 'ids' });
    ids.append(idPill('researchId', status.researchId));
    ids.append(idPill('currentRunId', status.discovery.runId));
    if (status.currentEnrichmentId) ids.append(idPill('enrichmentId', status.currentEnrichmentId));
    app.append(ids, spacer(18));

    const grid = node('div', { className: 'grid' });
    const left = node('div', { className: 'stack' });
    const right = node('div', { className: 'stack' });

    left.append(renderPipeline(status));
    left.append(renderDiscovery(status));
    left.append(renderBatches(container, status));
    right.append(renderNextAction(status));
    right.append(renderResearchFacts(status, container, operatorConfig));
    right.append(renderConfig(operatorConfig));

    grid.append(left, right);
    app.append(grid);
  } catch (error) {
    app.replaceChildren();
    app.append(pageHeader('Research unavailable', 'The durable projection could not be loaded.'));
    const panel = node('div', { className: 'panel' });
    renderError(panel, error);
    app.append(panel);
  }
}

function renderPipeline(status) {
  const section = panelSection('Pipeline', 'Current durable stage projection.');
  const pipeline = node('div', { className: 'pipeline' });

  pipeline.append(
    pipelineStep('Discovery', displayState(status.discovery.state), discoveryClass(status.discovery.state)),
    pipelineStep(
      'Enrichment',
      status.currentEnrichmentId ? displayState(currentEnrichment(status)?.state ?? 'unknown') : 'Not started',
      status.currentEnrichmentId ? genericStageClass(currentEnrichment(status)?.state) : '',
    ),
    pipelineStep('Finalization', displayState(status.finalization.state), genericStageClass(status.finalization.state)),
    pipelineStep('Library', status.library.published ? 'Published' : 'Not published', status.library.published ? 'done' : ''),
  );
  section.append(pipeline);
  return section;
}

function renderDiscovery(status) {
  const section = panelSection('Discovery', `Generation ${status.discovery.generation} · ${displayState(status.discovery.state)}`);
  const counts = status.discovery.keywordCounts;
  const metrics = node('div', { className: 'metrics' });
  metrics.append(
    metric(counts.total, 'Total'),
    metric(counts.completed, 'Completed'),
    metric(counts.partial, 'Partial'),
    metric(counts.failed, 'Failed'),
    metric(counts.pending, 'Pending'),
    metric(counts.repairable, 'Repairable'),
  );
  section.append(metrics);

  if (status.discovery.qualityWarnings?.length) {
    const details = node('details');
    const summary = node('summary', { text: `${status.discovery.qualityWarnings.length} quality warning(s)` });
    const pre = node('pre', { text: JSON.stringify(status.discovery.qualityWarnings, null, 2) });
    details.append(summary, pre);
    section.append(spacer(14), details);
  }
  return section;
}

function renderNextAction(status) {
  const section = panelSection('Next action');
  const body = node('div', { className: 'next-action' });
  body.append(
    node('strong', { text: status.nextAction.code === 'none' ? 'Nothing required' : humanize(status.nextAction.code) }),
    node('p', { text: status.nextAction.message }),
  );
  section.append(body);
  return section;
}

function renderBatches(container, status) {
  const section = panelSection('Batches & history');
  if (!container) {
    section.append(node('div', { className: 'muted small', text: 'No managed research container is available for this historical layout.' }));
    return section;
  }

  const timeline = node('div', { className: 'timeline' });
  for (const batch of container.batches) {
    const item = node('div', { className: 'timeline-item' });
    item.append(
      node('code', { text: batch.batchId }),
      timelineDescription(batch),
      batch.resultRunId === status.discovery.runId ? badge('current', 'info') : node('span'),
    );
    timeline.append(item);
  }
  section.append(timeline);
  return section;
}

function timelineDescription(batch) {
  const block = node('div');
  block.append(
    node('div', { className: 'timeline-primary', text: `${batch.inputUniqueKeywordCount} supplied · ${batch.addedKeywordCount} added · ${batch.duplicateKeywordCount} duplicates` }),
    node('div', { className: 'timeline-secondary', text: `${batch.resultRunId} · ${formatDate(batch.createdAt)}` }),
  );
  return block;
}

function renderResearchFacts(status, container, operatorConfig) {
  const section = panelSection('Research info');
  const kv = node('div', { className: 'kv' });
  kv.append(
    kvRow('Layout', status.legacy ? 'legacy' : 'current'),
    kvRow('Batches', container ? String(container.batches.length) : 'n/a'),
    kvRow('Discovery generation', String(status.discovery.generation)),
    kvRow('Enrichments', String(status.enrichments.length)),
    kvRow('Finalization', displayState(status.finalization.state)),
    kvRow('Library', status.library.published ? 'published' : status.library.reason ?? 'not published'),
    kvRow('Operator config', operatorConfig ? 'available' : 'not available'),
    kvRow('Directory', status.researchDirectory),
  );
  section.append(kv);
  return section;
}

function renderConfig(operatorConfig) {
  const section = panelSection('Configuration');
  if (!operatorConfig) {
    section.append(node('div', { className: 'muted small', text: 'No persisted OperatorConfig provenance is available.' }));
    return section;
  }

  const semantics = operatorConfig.semantics;
  const kv = node('div', { className: 'kv' });
  kv.append(
    kvRow('Workflow', semantics.workflow?.target ?? 'unknown'),
    kvRow('Market', semantics.research?.market ?? 'unknown'),
    kvRow('Google', `${semantics.research?.googleHl ?? '?'} / ${semantics.research?.googleGl ?? '?'}`),
    kvRow('Expansion', semantics.discovery?.expand ? 'enabled' : 'disabled'),
    kvRow('Enrichment modules', semantics.enrichment?.modules?.join(', ') || 'none'),
    kvRow('Config fingerprint', operatorConfig.effectiveConfigFingerprint),
  );
  section.append(kv);

  const details = node('details');
  details.append(
    node('summary', { text: 'Raw immutable provenance' }),
    node('pre', { text: JSON.stringify(operatorConfig, null, 2) }),
  );
  section.append(spacer(14), details);
  return section;
}

async function renderSystem() {
  app.replaceChildren(pageHeader('System', 'Read-only diagnostics for the canonical local Runner storage.'));
  const holder = node('div', { className: 'loading', text: 'Loading diagnostics…' });
  app.append(holder);
  try {
    const payload = await api('/api/system');
    const outputs = payload.outputs;
    const grid = node('div', { className: 'system-grid' });

    const storage = node('div', { className: 'panel system-card' });
    storage.append(
      node('h2', { text: 'Canonical storage' }),
      badge(outputs.rootExists ? 'Available' : 'Missing', outputs.rootExists ? 'good' : 'warn'),
      spacer(12),
      node('div', { className: 'path', text: outputs.canonicalRoot }),
      spacer(12),
      kvRow('Configured by', outputs.configuredBy),
      kvRow('Researches namespace', outputs.researchesDirectoryExists ? 'present' : 'not initialized'),
    );

    const policy = node('div', { className: 'panel system-card' });
    policy.append(
      node('h2', { text: 'Output policy' }),
      badge(outputs.overrideEscapeHatchEnabled ? 'Override enabled' : 'Canonical only', outputs.overrideEscapeHatchEnabled ? 'warn' : 'good'),
      spacer(12),
      kvRow('Researches', outputs.layout.researches),
      kvRow('Index', outputs.layout.index),
      kvRow('Library', outputs.layout.researchLibrary),
      kvRow('First-party search', outputs.layout.firstPartySearch),
    );

    const legacy = node('div', { className: 'panel system-card' });
    legacy.append(node('h2', { text: 'Repo-local legacy outputs' }));
    if (outputs.repoLocalLegacyDirectories?.length) {
      legacy.append(badge(`${outputs.repoLocalLegacyDirectories.length} detected`, 'warn'));
      for (const path of outputs.repoLocalLegacyDirectories) legacy.append(spacer(10), node('div', { className: 'path', text: path }));
    } else {
      legacy.append(badge('None detected', 'good'));
    }

    grid.append(storage, policy, legacy);
    holder.replaceWith(grid);
  } catch (error) {
    renderError(holder, error);
  }
}

function pageHeader(title, subtitle) {
  const header = node('div', { className: 'page-header' });
  const block = node('div');
  block.append(node('h1', { text: title }), node('p', { text: subtitle }));
  header.append(block);
  return header;
}

function panelSection(title, subtitle = '') {
  const section = node('section', { className: 'panel section' });
  section.append(node('h2', { text: title }));
  if (subtitle) section.append(node('div', { className: 'section-subtitle', text: subtitle }));
  return section;
}

function pipelineStep(name, state, className = '') {
  const step = node('div', { className: `pipeline-step ${className}`.trim() });
  step.append(node('div', { className: 'step-name', text: name }), node('div', { className: 'step-state', text: state }));
  return step;
}

function cell(label, value) {
  const wrapper = node('div');
  wrapper.append(node('div', { className: 'cell-label', text: label }), node('div', { className: 'cell-value', text: value }));
  return wrapper;
}

function kvRow(key, value) {
  const row = node('div', { className: 'kv-row' });
  row.append(node('div', { className: 'kv-key', text: key }), node('div', { className: 'kv-value', text: value ?? 'n/a' }));
  return row;
}

function metric(value, label) {
  const item = node('div', { className: 'metric' });
  item.append(node('div', { className: 'number', text: String(value) }), node('div', { className: 'label', text: label }));
  return item;
}

function idPill(label, value) {
  const pill = node('div', { className: 'id-pill' });
  const copy = node('button', { className: 'copy', type: 'button', text: 'Copy' });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      copy.textContent = 'Copied';
      window.setTimeout(() => { copy.textContent = 'Copy'; }, 900);
    } catch {
      copy.textContent = 'Failed';
      window.setTimeout(() => { copy.textContent = 'Copy'; }, 900);
    }
  });
  pill.append(node('span', { text: label }), node('code', { text: value }), copy);
  return pill;
}

function badge(text, tone = '') {
  return node('span', { className: `badge ${tone}`.trim(), text });
}

function spacer(height) {
  return node('div', { style: `height:${height}px` });
}

function currentEnrichment(status) {
  return status.enrichments?.find((item) => item.enrichmentId === status.currentEnrichmentId) ?? null;
}

function discoveryClass(state) {
  if (state === 'completed') return 'done';
  if (state === 'completed_with_errors' || state === 'paused' || state === 'failed') return 'attention';
  return '';
}

function genericStageClass(state) {
  if (state === 'completed' || state === 'published') return 'done';
  if (state === 'paused' || state === 'failed' || state === 'awaiting_decisions') return 'attention';
  return '';
}

function summaryLine(status, container) {
  const batches = container ? `${container.batches.length} batch${container.batches.length === 1 ? '' : 'es'}` : 'historical run';
  return `${batches} · current discovery ${displayState(status.discovery.state)}`;
}

function displayState(value) {
  return humanize(String(value ?? 'unknown'));
}

function humanize(value) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

async function api(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`HTTP ${response.status}: invalid JSON response`);
  }
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  return payload;
}

function renderError(container, error) {
  container.replaceChildren();
  const state = node('div', { className: 'error-state' });
  state.append(node('strong', { text: 'Could not load data' }), node('div', { text: error instanceof Error ? error.message : String(error) }));
  container.append(state);
}

function node(tag, options = {}) {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = String(options.text);
  if (options.type) element.setAttribute('type', options.type);
  if (options.href) element.setAttribute('href', options.href);
  if (options.placeholder) element.setAttribute('placeholder', options.placeholder);
  if (options.ariaLabel) element.setAttribute('aria-label', options.ariaLabel);
  if (options.style) element.setAttribute('style', options.style);
  return element;
}
