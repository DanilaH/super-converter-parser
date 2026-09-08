const app = document.querySelector('#app');
const navLinks = [...document.querySelectorAll('[data-nav]')];
const CONTINUABLE_ACTIONS = new Set([
  'resume_discovery',
  'run_enrichment',
  'resume_enrichment',
  'run_finalization',
  'publish_library',
]);
const PRESETS = [
  { id: 'quick-scan', label: 'Quick scan' },
  { id: 'standard', label: 'Standard' },
  { id: 'deep-research', label: 'Deep research' },
  { id: 'finalist-validation', label: 'Finalist validation' },
];

if (!app) throw new Error('Missing #app root.');

let routeEpoch = 0;
window.addEventListener('hashchange', () => void route());
void route();

async function route() {
  const epoch = ++routeEpoch;
  const hash = window.location.hash || '#/researches';
  const navName = hash === '#/new' ? 'new' : hash.startsWith('#/system') ? 'system' : 'researches';
  setActiveNav(navName);

  if (hash === '#/system') {
    await renderSystem(epoch);
    return;
  }
  if (hash === '#/new') {
    await renderNewResearch(epoch);
    return;
  }
  if (hash.startsWith('#/research/')) {
    const id = decodeURIComponent(hash.slice('#/research/'.length));
    await renderResearchDetail(id, epoch);
    return;
  }
  if (hash !== '#/researches') window.location.hash = '#/researches';
  await renderResearchList(epoch);
}

function setActiveNav(name) {
  for (const link of navLinks) link.classList.toggle('active', link.dataset.nav === name);
}

async function renderResearchList(epoch) {
  const header = pageHeader('Researches', 'Browse durable researches from the canonical Runner output root.');
  header.append(node('a', { className: 'button primary link-button', href: '#/new', text: 'New research' }));
  app.replaceChildren(header);

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
      if (epoch !== routeEpoch) return;
      renderResearchRows(list, payload.researches ?? []);
    } catch (error) {
      if (epoch === routeEpoch) renderError(list, error);
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
    const empty = node('div', { className: 'empty' });
    empty.append(
      node('strong', { text: 'No researches found.' }),
      node('p', { text: 'Create one from the local console or change the search.' }),
      node('a', { className: 'button primary link-button', href: '#/new', text: 'New research' }),
    );
    container.append(empty);
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

async function renderNewResearch(epoch) {
  app.replaceChildren(pageHeader('New research', 'Configure, preview, and start a research without authoring JSON or using the CLI.'));

  const layout = node('div', { className: 'create-grid' });
  const formPanel = node('section', { className: 'panel create-panel' });
  const side = node('div', { className: 'stack' });
  const previewHolder = node('section', { className: 'panel create-panel preview-panel' });
  const jobHolder = node('section', { className: 'panel create-panel job-panel hidden' });
  side.append(previewHolder, jobHolder);
  layout.append(formPanel, side);
  app.append(layout);

  const form = node('form', { className: 'research-form' });
  formPanel.append(
    node('h2', { text: 'Research setup' }),
    node('div', { className: 'section-subtitle', text: 'Preset semantics remain the canonical Runner presets. Locale fields are optional overrides.' }),
    form,
  );

  const label = formControl('Name', 'input', {
    type: 'text',
    placeholder: 'e.g. browser audio tools',
    autocomplete: 'off',
  });
  const preset = formControl('Preset', 'select');
  for (const item of PRESETS) {
    const option = node('option', { text: item.label, value: item.id });
    if (item.id === 'standard') option.selected = true;
    preset.control.append(option);
  }
  const keywords = formControl('Seed keywords', 'textarea', {
    placeholder: 'one keyword per line\nmic test\nheadphone test\nspeaker test',
    rows: 14,
  });
  keywords.wrapper.append(node('div', { className: 'field-help', text: 'One seed per line. The preview reports both supplied lines and normalized unique keywords.' }));

  const advanced = node('details', { className: 'advanced-fields' });
  advanced.append(node('summary', { text: 'Locale overrides' }));
  const localeGrid = node('div', { className: 'locale-grid' });
  const market = formControl('Market', 'input', { type: 'text', placeholder: 'US', autocomplete: 'off' });
  const googleHl = formControl('Google hl', 'input', { type: 'text', placeholder: 'en', autocomplete: 'off' });
  const googleGl = formControl('Google gl', 'input', { type: 'text', placeholder: 'us', autocomplete: 'off' });
  localeGrid.append(market.wrapper, googleHl.wrapper, googleGl.wrapper);
  advanced.append(localeGrid, node('div', { className: 'field-help', text: 'Leave empty to use the selected preset/default semantics.' }));

  const actions = node('div', { className: 'form-actions' });
  const previewButton = node('button', { className: 'button', type: 'submit', text: 'Preview plan' });
  const startButton = node('button', { className: 'button primary', type: 'button', text: 'Start research', disabled: true });
  const formState = node('div', { className: 'form-state muted', text: 'Preview the current draft before starting.' });
  actions.append(previewButton, startButton, formState);
  form.append(label.wrapper, preset.wrapper, keywords.wrapper, advanced, actions);
  renderPreviewPlaceholder(previewHolder);

  let previewKey = null;
  let busy = false;
  const inputs = [label.control, preset.control, keywords.control, market.control, googleHl.control, googleGl.control];
  const setBusy = (value) => {
    busy = value;
    for (const control of inputs) control.disabled = value;
    previewButton.disabled = value;
    startButton.disabled = value || previewKey === null;
    form.classList.toggle('is-busy', value);
  };
  const invalidatePreview = () => {
    if (busy) return;
    previewKey = null;
    startButton.disabled = true;
    formState.textContent = 'Draft changed — preview again before starting.';
  };
  for (const control of inputs) {
    control.addEventListener('input', invalidatePreview);
    control.addEventListener('change', invalidatePreview);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    previewButton.disabled = true;
    formState.textContent = 'Validating plan…';
    try {
      const draft = createDraftFromControls({ label, preset, keywords, market, googleHl, googleGl });
      const payload = await apiMutation('/api/researches/plan', draft);
      if (epoch !== routeEpoch) return;
      previewKey = JSON.stringify(draft);
      renderPlanPreview(previewHolder, payload.plan);
      formState.textContent = 'Plan is current. Ready to start.';
      startButton.disabled = false;
    } catch (error) {
      if (epoch !== routeEpoch) return;
      previewKey = null;
      startButton.disabled = true;
      renderPanelError(previewHolder, 'Plan rejected', error);
      formState.textContent = 'Fix the draft and preview again.';
    } finally {
      if (epoch === routeEpoch && !busy) previewButton.disabled = false;
    }
  });

  startButton.addEventListener('click', async () => {
    if (busy || previewKey === null) return;
    const draft = createDraftFromControls({ label, preset, keywords, market, googleHl, googleGl });
    if (JSON.stringify(draft) !== previewKey) {
      invalidatePreview();
      return;
    }
    setBusy(true);
    jobHolder.classList.remove('hidden');
    jobHolder.replaceChildren(node('div', { className: 'loading compact-loading', text: 'Starting research…' }));
    formState.textContent = 'Research job is starting…';
    try {
      const payload = await apiMutation('/api/researches', draft);
      if (epoch !== routeEpoch) return;
      formState.textContent = 'Research is running. Durable progress appears as soon as the research is initialized.';
      await pollJob(payload.job.jobId, jobHolder, epoch, {
        onTerminal: () => {
          setBusy(false);
          previewKey = null;
          startButton.disabled = true;
          formState.textContent = 'Job finished. Preview again before starting another research.';
        },
      });
    } catch (error) {
      if (epoch !== routeEpoch) return;
      setBusy(false);
      renderPanelError(jobHolder, 'Could not start research', error);
      formState.textContent = 'Start failed. The draft is unchanged.';
    }
  });

  try {
    const payload = await api('/api/jobs');
    if (epoch !== routeEpoch) return;
    const active = (payload.jobs ?? []).find((job) => job.state === 'running');
    if (active) {
      setBusy(true);
      jobHolder.classList.remove('hidden');
      formState.textContent = 'Another UI execution job is already running.';
      await pollJob(active.jobId, jobHolder, epoch, {
        onTerminal: () => {
          setBusy(false);
          formState.textContent = 'Previous job finished. Preview this draft before starting.';
        },
      });
    }
  } catch (error) {
    if (epoch === routeEpoch) renderPanelError(jobHolder, 'Could not inspect active jobs', error);
  }
}

function createDraftFromControls(controls) {
  const draft = {
    version: 1,
    label: controls.label.control.value,
    preset: controls.preset.control.value,
    keywords: controls.keywords.control.value,
  };
  const market = controls.market.control.value.trim();
  const googleHl = controls.googleHl.control.value.trim();
  const googleGl = controls.googleGl.control.value.trim();
  if (market) draft.market = market;
  if (googleHl) draft.googleHl = googleHl;
  if (googleGl) draft.googleGl = googleGl;
  return draft;
}

function renderPreviewPlaceholder(container) {
  container.replaceChildren(
    node('h2', { text: 'Plan preview' }),
    node('p', { className: 'muted preview-copy', text: 'Preview resolves the real OperatorConfig preset and shows what the Runner will execute before any research is created.' }),
  );
}

function renderPlanPreview(container, plan) {
  container.replaceChildren();
  const header = node('div', { className: 'panel-title-row' });
  header.append(node('h2', { text: 'Plan preview' }), badge(`${humanize(plan.workflowTarget)} target`, 'info'));
  container.append(header);

  const metrics = node('div', { className: 'preview-metrics' });
  metrics.append(metric(plan.inputLineCount, 'Input lines'), metric(plan.uniqueKeywordCount, 'Unique'));
  container.append(metrics);

  const stages = node('div', { className: 'preview-stages' });
  for (const stage of plan.stages ?? []) {
    const stageNode = node('div', { className: `preview-stage ${stage.state === 'ready' ? 'ready' : ''}`.trim() });
    stageNode.append(node('strong', { text: humanize(stage.id) }), node('span', { text: humanize(stage.state) }));
    if (stage.reason) stageNode.append(node('small', { text: stage.reason }));
    stages.append(stageNode);
  }
  container.append(stages);

  const semantics = plan.semantics;
  const kv = node('div', { className: 'kv preview-kv' });
  kv.append(
    kvRow('Preset', plan.preset ? `${plan.preset.id}@${plan.preset.revision}` : 'none'),
    kvRow('Market', semantics.research.market),
    kvRow('Google', `${semantics.research.googleHl} / ${semantics.research.googleGl}`),
    kvRow('Top N', String(semantics.discovery.topN)),
    kvRow('Expansion', semantics.discovery.expand ? 'enabled' : 'disabled'),
    kvRow('Ahrefs required', semantics.discovery.requireAhrefs ? 'yes' : 'no'),
    kvRow('Enrichment', semantics.enrichmentModules.length ? semantics.enrichmentModules.join(', ') : 'none'),
  );
  container.append(kv);

  if (plan.externalWork?.length) {
    const providers = [...new Set(plan.externalWork.flatMap((item) => item.providers ?? []))];
    if (providers.length) container.append(node('div', { className: 'plan-note', text: `External work: ${providers.join(', ')}` }));
  }
  if (plan.unresolvedHumanRequirements?.length) {
    container.append(node('div', { className: 'plan-note attention-note', text: `Expected human stop: ${plan.unresolvedHumanRequirements.map(humanize).join(', ')}` }));
  }
}

async function renderResearchDetail(researchId, epoch) {
  app.replaceChildren(node('div', { className: 'loading', text: 'Loading research…' }));
  try {
    const [detail, jobsPayload] = await Promise.all([
      api(`/api/researches/${encodeURIComponent(researchId)}`),
      api('/api/jobs').catch(() => ({ jobs: [] })),
    ]);
    if (epoch !== routeEpoch) return;
    const { status, container, operatorConfig } = detail;
    const activeJob = (jobsPayload.jobs ?? []).find((job) => job.state === 'running') ?? null;
    const activeForThisResearch = activeJob?.researchId === status.researchId ? activeJob : null;
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

    const operationHolder = node('section', { className: `panel create-panel job-panel ${activeForThisResearch ? '' : 'hidden'}`.trim() });
    const continueInfo = continuableAction(status, operatorConfig);
    if (continueInfo) {
      const continueButton = node('button', {
        className: 'button primary detail-action',
        type: 'button',
        text: continueInfo.label,
        disabled: Boolean(activeJob),
      });
      if (activeJob && !activeForThisResearch) continueButton.title = 'Another UI execution job is currently running.';
      continueButton.addEventListener('click', async () => {
        continueButton.disabled = true;
        operationHolder.classList.remove('hidden');
        operationHolder.replaceChildren(node('div', { className: 'loading compact-loading', text: 'Starting continuation…' }));
        try {
          const payload = await apiMutation(`/api/researches/${encodeURIComponent(status.researchId)}/resume`, {});
          if (epoch !== routeEpoch) return;
          await pollJob(payload.job.jobId, operationHolder, epoch, {
            onTerminal: async () => {
              if (epoch === routeEpoch) await renderResearchDetail(status.researchId, epoch);
            },
          });
        } catch (error) {
          if (epoch !== routeEpoch) return;
          continueButton.disabled = false;
          renderPanelError(operationHolder, 'Could not continue research', error);
        }
      });
      header.append(continueButton);
    }
    app.append(header);

    const ids = node('div', { className: 'ids' });
    ids.append(idPill('researchId', status.researchId));
    ids.append(idPill('currentRunId', status.discovery.runId));
    if (status.currentEnrichmentId) ids.append(idPill('enrichmentId', status.currentEnrichmentId));
    app.append(ids, spacer(18), operationHolder);

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

    if (activeForThisResearch) {
      void pollJob(activeForThisResearch.jobId, operationHolder, epoch, {
        onTerminal: async () => {
          if (epoch === routeEpoch) await renderResearchDetail(status.researchId, epoch);
        },
      });
    }
  } catch (error) {
    if (epoch !== routeEpoch) return;
    app.replaceChildren();
    app.append(pageHeader('Research unavailable', 'The durable projection could not be loaded.'));
    const panel = node('div', { className: 'panel' });
    renderError(panel, error);
    app.append(panel);
  }
}

function continuableAction(status, operatorConfig) {
  if (!operatorConfig || status.legacy || !status.nextAction?.command || !CONTINUABLE_ACTIONS.has(status.nextAction.code)) return null;
  const labels = {
    resume_discovery: 'Resume discovery',
    run_enrichment: 'Run enrichment',
    resume_enrichment: 'Resume enrichment',
    run_finalization: 'Continue finalization',
    publish_library: 'Continue library step',
  };
  return { code: status.nextAction.code, label: labels[status.nextAction.code] ?? 'Continue research' };
}

async function pollJob(jobId, container, epoch, options = {}) {
  let cachedDetail = null;
  let lastDetailAt = 0;
  while (epoch === routeEpoch) {
    let job;
    try {
      const payload = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
      job = payload.job;
    } catch (error) {
      if (epoch === routeEpoch) renderPanelError(container, 'Could not poll job', error);
      return;
    }

    if (job.researchId && (Date.now() - lastDetailAt > 3000 || job.state !== 'running')) {
      try {
        cachedDetail = await api(`/api/researches/${encodeURIComponent(job.researchId)}`);
        lastDetailAt = Date.now();
      } catch {
        // Fresh research initialization and the first readable durable snapshot can be a few checkpoints apart.
      }
    }
    if (epoch !== routeEpoch) return;
    renderJobSnapshot(container, job, cachedDetail);

    if (job.state !== 'running') {
      await options.onTerminal?.(job, cachedDetail);
      return;
    }
    await delay(1000);
  }
}

function renderJobSnapshot(container, job, detail) {
  container.classList.remove('hidden');
  container.replaceChildren();
  const title = node('div', { className: 'panel-title-row' });
  const tone = job.state === 'running' ? 'info' : job.state === 'failed' ? 'warn' : 'good';
  const stateLabel = job.state === 'finished' ? 'Job finished' : job.state === 'failed' ? 'Job failed' : 'Running';
  title.append(node('h2', { text: job.kind === 'create_research' ? 'Research job' : 'Continuation job' }), badge(stateLabel, tone));
  container.append(title);

  if (job.researchId) {
    const identity = node('div', { className: 'job-identity' });
    identity.append(idPill('researchId', job.researchId));
    const open = node('button', { className: 'button compact', type: 'button', text: 'Open research' });
    open.addEventListener('click', () => {
      window.location.hash = `#/research/${encodeURIComponent(job.researchId)}`;
    });
    identity.append(open);
    container.append(identity);
  } else if (job.state === 'running') {
    container.append(node('p', { className: 'muted preview-copy', text: 'Initializing durable research state…' }));
  }

  if (detail?.status) {
    const status = detail.status;
    const counts = status.discovery?.keywordCounts;
    const live = node('div', { className: 'job-live' });
    live.append(
      kvRow('Discovery', displayState(status.discovery?.state)),
      kvRow('Next durable action', humanize(status.nextAction?.code ?? 'unknown')),
    );
    if (counts) {
      live.append(kvRow('Keywords', `${counts.completed + counts.partial + counts.failed}/${counts.total} terminal · ${counts.pending} pending`));
    }
    container.append(live);
  }

  if (job.state === 'finished' && job.result) {
    const result = node('div', { className: 'job-result' });
    result.append(
      kvRow('Workflow', humanize(job.result.workflowState)),
      kvRow('Stop point', humanize(job.result.stopPoint)),
      kvRow('Exit code', String(job.result.exitCode)),
    );
    if (job.result.unresolvedHumanRequirements?.length) {
      result.append(node('div', { className: 'plan-note attention-note', text: `Human input required: ${job.result.unresolvedHumanRequirements.map(humanize).join(', ')}` }));
    }
    container.append(result);
  }

  if (job.state === 'failed') {
    container.append(node('div', { className: 'plan-note error-note', text: `${job.error?.code ?? 'INTERNAL_ERROR'}: ${job.error?.message ?? 'Unknown job error'}` }));
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
  if (status.nextAction.code === 'repair_discovery') {
    body.append(node('div', { className: 'action-note', text: 'Repair remains explicit and will be added in U2.3.' }));
  } else if (!status.nextAction.command && status.nextAction.code !== 'none') {
    body.append(node('div', { className: 'action-note', text: 'This step requires explicit human input; the console will not invent it.' }));
  }
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

async function renderSystem(epoch) {
  app.replaceChildren(pageHeader('System', 'Read-only diagnostics for the canonical local Runner storage.'));
  const holder = node('div', { className: 'loading', text: 'Loading diagnostics…' });
  app.append(holder);
  try {
    const payload = await api('/api/system');
    if (epoch !== routeEpoch) return;
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
    if (epoch === routeEpoch) renderError(holder, error);
  }
}

function formControl(label, tag, options = {}) {
  const wrapper = node('label', { className: 'field' });
  wrapper.append(node('span', { className: 'field-label', text: label }));
  const control = node(tag, { className: 'control', ...options });
  wrapper.append(control);
  return { wrapper, control };
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
  return String(value).replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

async function api(path) {
  return requestJson(path, { headers: { Accept: 'application/json' } });
}
async function apiMutation(path, value) {
  return requestJson(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
}
async function requestJson(path, options) {
  const response = await fetch(path, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`HTTP ${response.status}: invalid JSON response`);
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
    error.code = payload?.error?.code ?? `HTTP_${response.status}`;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function renderError(container, error) {
  container.replaceChildren();
  const state = node('div', { className: 'error-state' });
  state.append(node('strong', { text: 'Could not load data' }), node('div', { text: error instanceof Error ? error.message : String(error) }));
  container.append(state);
}
function renderPanelError(container, title, error) {
  container.classList.remove('hidden');
  container.replaceChildren(
    node('h2', { text: title }),
    node('div', { className: 'plan-note error-note', text: `${error?.code ? `${error.code}: ` : ''}${error instanceof Error ? error.message : String(error)}` }),
  );
}
function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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
  if (options.autocomplete) element.setAttribute('autocomplete', options.autocomplete);
  if (options.rows !== undefined) element.setAttribute('rows', String(options.rows));
  if (options.value !== undefined) element.value = options.value;
  if (options.disabled !== undefined) element.disabled = Boolean(options.disabled);
  return element;
}
