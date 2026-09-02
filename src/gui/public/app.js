const state = {
  bootstrap: null,
  newDraftId: null,
  existingDraftId: null,
  researchId: null,
  status: null,
  clusters: [],
  evidence: null,
};

const byId = (id) => document.getElementById(id);

const elements = {
  outputRoot: byId('output-root'),
  preset: byId('preset'),
  presetHint: byId('preset-hint'),
  researchLabel: byId('research-label'),
  inputType: byId('input-type'),
  inputFile: byId('input-file'),
  market: byId('market'),
  googleHl: byId('google-hl'),
  googleGl: byId('google-gl'),
  workflowTarget: byId('workflow-target'),
  topN: byId('top-n'),
  expand: byId('expand'),
  requireAhrefs: byId('require-ahrefs'),
  enrichmentSection: byId('enrichment-section'),
  moduleOptions: byId('module-options'),
  finalizationDetails: byId('finalization-details'),
  overrideFinalization: byId('override-finalization'),
  finalizationFields: byId('finalization-fields'),
  representativeCount: byId('representative-count'),
  youngDays: byId('young-days'),
  recentDays: byId('recent-days'),
  repurposeDays: byId('repurpose-days'),
  collectionMode: byId('collection-mode'),
  recentMonths: byId('recent-months'),
  maxCollections: byId('max-collections'),
  domainCap: byId('domain-cap'),
  planNew: byId('plan-new'),
  runNew: byId('run-new'),
  newState: byId('new-state'),
  newError: byId('new-error'),
  newResult: byId('new-result'),
  newPlan: byId('new-plan'),
  researchSelect: byId('research-select'),
  researchId: byId('research-id'),
  openResearch: byId('open-research'),
  refreshResearches: byId('refresh-researches'),
  researchListWarning: byId('research-list-warning'),
  existingError: byId('existing-error'),
  statusArea: byId('status-area'),
  evidenceArea: byId('evidence-area'),
  continuationCard: byId('continuation-card'),
  continuationAction: byId('continuation-action'),
  continuationFields: byId('continuation-fields'),
  continuationHint: byId('continuation-hint'),
  clusterSelector: byId('cluster-selector'),
  decisionEditor: byId('decision-editor'),
  planExisting: byId('plan-existing'),
  runExisting: byId('run-existing'),
  existingState: byId('existing-state'),
  existingResult: byId('existing-result'),
  existingPlan: byId('existing-plan'),
};

void initialize();

async function initialize() {
  bindTabs();
  bindActions();
  try {
    state.bootstrap = await api('/api/bootstrap');
    elements.outputRoot.textContent = state.bootstrap.outputRoot;
    initializeNewResearchForm();
    initializeContinuationActions();
    await refreshResearches();
  } catch (error) {
    showError(elements.newError, error);
    showError(elements.existingError, error);
  }
}

function bindTabs() {
  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.addEventListener('click', () => {
      const active = tab.dataset.tab;
      for (const candidate of document.querySelectorAll('[data-tab]')) {
        candidate.classList.toggle('is-active', candidate === tab);
      }
      byId('new-panel').hidden = active !== 'new';
      byId('existing-panel').hidden = active !== 'existing';
    });
  }
}

function bindActions() {
  elements.preset.addEventListener('change', () => {
    applyPreset(elements.preset.value);
    invalidateNewPlan();
  });
  elements.workflowTarget.addEventListener('change', () => {
    syncNewVisibility();
    invalidateNewPlan();
  });
  elements.overrideFinalization.addEventListener('change', () => {
    syncNewVisibility();
    invalidateNewPlan();
  });
  byId('new-form').addEventListener('input', (event) => {
    if (event.target !== elements.preset && event.target !== elements.workflowTarget && event.target !== elements.overrideFinalization) {
      invalidateNewPlan();
    }
  });
  byId('new-form').addEventListener('change', (event) => {
    if (event.target !== elements.preset && event.target !== elements.workflowTarget && event.target !== elements.overrideFinalization) {
      invalidateNewPlan();
    }
  });
  elements.planNew.addEventListener('click', () => void planNewResearch());
  elements.runNew.addEventListener('click', () => void runNewResearch());
  elements.refreshResearches.addEventListener('click', () => void refreshResearches());
  elements.researchSelect.addEventListener('change', () => {
    if (elements.researchSelect.value) elements.researchId.value = elements.researchSelect.value;
  });
  elements.openResearch.addEventListener('click', () => void openResearch());
  elements.researchId.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void openResearch();
  });
  elements.continuationAction.addEventListener('change', () => {
    renderContinuationFields(elements.continuationAction.value);
    invalidateExistingPlan();
  });
  elements.continuationFields.addEventListener('input', invalidateExistingPlan);
  elements.continuationFields.addEventListener('change', invalidateExistingPlan);
  elements.clusterSelector.addEventListener('change', invalidateExistingPlan);
  elements.decisionEditor.addEventListener('input', invalidateExistingPlan);
  elements.planExisting.addEventListener('click', () => void planExistingResearch());
  elements.runExisting.addEventListener('click', () => void runExistingResearch());
}

function initializeNewResearchForm() {
  const configSchema = state.bootstrap.schemas.researchConfig;
  const properties = configSchema.properties ?? {};
  const researchProperties = properties.research?.properties ?? {};
  const inputShapes = researchProperties.input?.oneOf ?? [];
  fillSelect(
    elements.inputType,
    inputShapes.map((shape) => shape.properties?.type?.const).filter(Boolean),
  );
  fillSelect(elements.workflowTarget, properties.workflow?.properties?.target?.enum ?? []);

  const modules = properties.enrichment?.properties?.modules?.items?.enum ?? [];
  elements.moduleOptions.replaceChildren(...modules.map((module) => {
    const label = document.createElement('label');
    label.className = 'check-item';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = module;
    input.dataset.module = module;
    const span = document.createElement('span');
    span.textContent = module;
    label.append(input, span);
    return label;
  }));

  elements.preset.replaceChildren();
  for (const preset of state.bootstrap.presets) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = `${preset.id}@${preset.revision}`;
    elements.preset.append(option);
  }
  const preferred = state.bootstrap.presets.some((preset) => preset.id === 'standard') ? 'standard' : state.bootstrap.presets[0]?.id ?? '';
  elements.preset.value = preferred;
  applyPreset(preferred);
}

function initializeContinuationActions() {
  const actionSchema = state.bootstrap.schemas.continuation.properties?.action;
  const actions = (actionSchema?.oneOf ?? [])
    .map((shape) => shape.properties?.type?.const)
    .filter(Boolean);
  elements.continuationAction.replaceChildren();
  addOption(elements.continuationAction, 'none', 'No human input / resume');
  for (const action of actions) addOption(elements.continuationAction, action, formatToken(action));
  elements.continuationAction.value = 'none';
  renderContinuationFields('none');
}

function applyPreset(id) {
  const preset = selectedPreset(id);
  const defaults = configDefaults();
  elements.presetHint.textContent = preset ? `${preset.id}@${preset.revision} — unchanged fields stay preset-owned.` : 'No preset selected.';
  elements.market.value = preset?.research?.market ?? defaults.market;
  elements.googleHl.value = preset?.research?.googleHl ?? defaults.googleHl;
  elements.googleGl.value = preset?.research?.googleGl ?? defaults.googleGl;
  elements.workflowTarget.value = preset?.workflow?.target ?? defaults.workflowTarget;
  elements.topN.value = String(preset?.discovery?.topN ?? defaults.topN);
  elements.expand.checked = preset?.discovery?.expand ?? defaults.expand;
  elements.requireAhrefs.checked = preset?.discovery?.requireAhrefs ?? defaults.requireAhrefs;

  const modules = new Set(preset?.enrichment?.modules ?? []);
  for (const input of elements.moduleOptions.querySelectorAll('input[data-module]')) {
    input.checked = modules.has(input.value);
  }

  const finalization = preset?.finalization;
  elements.overrideFinalization.checked = false;
  elements.representativeCount.value = String(finalization?.representativeCount ?? 5);
  elements.youngDays.value = String(finalization?.historyPolicy?.youngDomainMaxAgeDays ?? 730);
  elements.recentDays.value = String(finalization?.historyPolicy?.recentWebPresenceMaxAgeDays ?? 1095);
  elements.repurposeDays.value = String(finalization?.historyPolicy?.repurposeGapMinDays ?? 365);
  elements.collectionMode.value = finalization?.historicalPresence?.collectionMode ?? 'annual';
  elements.recentMonths.value = String(finalization?.historicalPresence?.recentMonths ?? 18);
  elements.maxCollections.value = String(finalization?.historicalPresence?.maxCollections ?? 24);
  elements.domainCap.value = String(finalization?.historicalPresence?.domainCap ?? 30);
  syncNewVisibility();
}

function syncNewVisibility() {
  const target = elements.workflowTarget.value;
  elements.enrichmentSection.hidden = target === 'discovery';
  elements.finalizationDetails.hidden = target !== 'finalization';
  const preset = selectedPreset(elements.preset.value);
  if (target === 'finalization' && !preset?.finalization) {
    elements.overrideFinalization.checked = true;
  }
  elements.finalizationFields.hidden = !elements.overrideFinalization.checked;
}

function configDefaults() {
  const properties = state.bootstrap.schemas.researchConfig.properties ?? {};
  return {
    market: properties.research?.properties?.market?.default ?? 'US',
    googleHl: properties.research?.properties?.googleHl?.default ?? 'en',
    googleGl: properties.research?.properties?.googleGl?.default ?? 'us',
    workflowTarget: properties.workflow?.properties?.target?.default ?? 'discovery',
    topN: properties.discovery?.properties?.topN?.default ?? 10,
    expand: properties.discovery?.properties?.expand?.default ?? false,
    requireAhrefs: properties.discovery?.properties?.requireAhrefs?.default ?? false,
  };
}

function selectedPreset(id = elements.preset.value) {
  return state.bootstrap.presets.find((preset) => preset.id === id) ?? null;
}

function invalidateNewPlan() {
  state.newDraftId = null;
  elements.runNew.disabled = true;
  elements.newState.textContent = 'Not planned';
  elements.newPlan.replaceChildren();
  hideError(elements.newError);
}

async function planNewResearch() {
  hideError(elements.newError);
  elements.planNew.disabled = true;
  elements.runNew.disabled = true;
  elements.newState.textContent = 'Planning…';
  try {
    const payload = await buildNewPayload();
    const planned = await api('/api/new/plan', { method: 'POST', body: payload });
    state.newDraftId = planned.draftId;
    renderPlan(elements.newPlan, planned.plan);
    elements.newState.textContent = 'Plan ready';
    elements.runNew.disabled = !state.newDraftId || !planHasExecutableStage(planned.plan);
  } catch (error) {
    state.newDraftId = null;
    elements.newState.textContent = 'Plan failed';
    showError(elements.newError, error);
  } finally {
    elements.planNew.disabled = false;
  }
}

async function buildNewPayload() {
  const file = elements.inputFile.files?.[0];
  if (!file) throw new Error('Choose an input file.');
  const label = elements.researchLabel.value.trim();
  if (!label) throw new Error('Research label is required.');

  const inputType = elements.inputType.value;
  const logicalPath = inputType === 'microsoft' ? 'input/microsoft.csv' : 'input/seeds.csv';
  const preset = selectedPreset();
  const defaults = configDefaults();
  const config = {
    version: 1,
    ...(preset ? { preset: preset.id } : {}),
    research: {
      label,
      input: { type: inputType, path: logicalPath },
    },
  };

  addOverride(config.research, 'market', elements.market.value.trim(), preset?.research?.market ?? defaults.market);
  addOverride(config.research, 'googleHl', elements.googleHl.value.trim(), preset?.research?.googleHl ?? defaults.googleHl);
  addOverride(config.research, 'googleGl', elements.googleGl.value.trim(), preset?.research?.googleGl ?? defaults.googleGl);

  const target = elements.workflowTarget.value;
  const baseTarget = preset?.workflow?.target ?? defaults.workflowTarget;
  if (target !== baseTarget) config.workflow = { target };

  const discovery = {
    topN: readNumber(elements.topN, 'Discovery top N'),
    expand: elements.expand.checked,
    requireAhrefs: elements.requireAhrefs.checked,
  };
  const baseDiscovery = {
    topN: preset?.discovery?.topN ?? defaults.topN,
    expand: preset?.discovery?.expand ?? defaults.expand,
    requireAhrefs: preset?.discovery?.requireAhrefs ?? defaults.requireAhrefs,
  };
  const discoveryOverride = diffObject(discovery, baseDiscovery);
  if (Object.keys(discoveryOverride).length > 0) config.discovery = discoveryOverride;

  const selectedModules = [...elements.moduleOptions.querySelectorAll('input[data-module]:checked')]
    .map((input) => input.value)
    .sort();
  const baseModules = [...(preset?.enrichment?.modules ?? [])].sort();
  if (!sameArray(selectedModules, baseModules)) config.enrichment = { modules: selectedModules };

  if (target === 'finalization' && elements.overrideFinalization.checked) {
    config.finalization = {
      representativeCount: readNumber(elements.representativeCount, 'Representatives'),
      historyPolicy: {
        youngDomainMaxAgeDays: readNumber(elements.youngDays, 'Young domain max days'),
        recentWebPresenceMaxAgeDays: readNumber(elements.recentDays, 'Recent web presence max days'),
        repurposeGapMinDays: readNumber(elements.repurposeDays, 'Repurpose gap min days'),
      },
      historicalPresence: {
        collectionMode: elements.collectionMode.value,
        recentMonths: readNumber(elements.recentMonths, 'Recent months'),
        maxCollections: readNumber(elements.maxCollections, 'Max collections'),
        domainCap: readNumber(elements.domainCap, 'Domain cap'),
      },
    };
  }

  return {
    config,
    files: { [logicalPath]: await file.text() },
  };
}

async function runNewResearch() {
  if (!state.newDraftId) return;
  hideError(elements.newError);
  const draftId = state.newDraftId;
  elements.planNew.disabled = true;
  elements.runNew.disabled = true;
  elements.runNew.textContent = 'Running…';
  elements.newState.textContent = 'Running';
  try {
    const execution = await api('/api/new/run', { method: 'POST', body: { draftId } });
    state.newDraftId = null;
    renderExecution(elements.newResult, execution);
    elements.newState.textContent = execution.exitCode === 0 ? 'Finished' : 'Stopped';
    await refreshResearches();
  } catch (error) {
    showError(elements.newError, error);
    elements.newState.textContent = 'Run failed';
  } finally {
    elements.planNew.disabled = false;
    elements.runNew.textContent = 'Start research';
  }
}

async function refreshResearches() {
  hideError(elements.existingError);
  elements.refreshResearches.disabled = true;
  try {
    const listed = await api('/api/researches');
    const previous = elements.researchSelect.value;
    elements.researchSelect.replaceChildren();
    addOption(elements.researchSelect, '', 'Select research…');
    for (const research of listed.researches) {
      addOption(
        elements.researchSelect,
        research.researchId,
        `${research.label} · ${research.discovery.state} · ${research.researchId}`,
      );
    }
    if ([...elements.researchSelect.options].some((option) => option.value === previous)) {
      elements.researchSelect.value = previous;
    }
    if (listed.errors.length > 0) {
      elements.researchListWarning.hidden = false;
      elements.researchListWarning.textContent = `${listed.errors.length} indexed run(s) could not be projected. Open by stable research ID if needed.`;
    } else {
      elements.researchListWarning.hidden = true;
      elements.researchListWarning.textContent = '';
    }
  } catch (error) {
    showError(elements.existingError, error);
  } finally {
    elements.refreshResearches.disabled = false;
  }
}

async function openResearch() {
  const researchId = (elements.researchId.value.trim() || elements.researchSelect.value).trim();
  if (!researchId) {
    showError(elements.existingError, new Error('Choose or enter a stable research ID.'));
    return;
  }
  hideError(elements.existingError);
  elements.openResearch.disabled = true;
  elements.statusArea.replaceChildren();
  elements.evidenceArea.replaceChildren();
  elements.existingPlan.replaceChildren();
  elements.existingResult.replaceChildren();
  elements.continuationCard.hidden = true;
  try {
    const encoded = encodeURIComponent(researchId);
    const [status, clusters, evidence, initialPlan] = await Promise.all([
      api(`/api/researches/${encoded}/status`),
      api(`/api/researches/${encoded}/clusters`),
      api(`/api/researches/${encoded}/finalist-evidence`),
      api(`/api/researches/${encoded}/plan`, { method: 'POST', body: { continuation: null } }),
    ]);
    state.researchId = status.researchId;
    state.status = status;
    state.clusters = Array.isArray(clusters) ? clusters : [];
    state.evidence = evidence;
    state.existingDraftId = null;
    elements.researchId.value = status.researchId;
    if ([...elements.researchSelect.options].some((option) => option.value === status.researchId)) {
      elements.researchSelect.value = status.researchId;
    }
    renderStatus(status);
    renderEvidence();
    renderPlan(elements.existingPlan, initialPlan.plan);
    elements.continuationCard.hidden = false;
    const action = suggestedContinuation(initialPlan.plan);
    elements.continuationAction.value = hasOption(elements.continuationAction, action) ? action : 'none';
    renderContinuationFields(elements.continuationAction.value);
    elements.existingState.textContent = 'Inspect current plan';
    elements.runExisting.disabled = true;
  } catch (error) {
    showError(elements.existingError, error);
    state.researchId = null;
    state.status = null;
    state.clusters = [];
    state.evidence = null;
  } finally {
    elements.openResearch.disabled = false;
  }
}

function renderStatus(status) {
  elements.statusArea.replaceChildren(
    metricCard('Research', status.label, status.researchId),
    metricCard(
      'Discovery',
      status.discovery.state,
      `${status.discovery.keywordCounts.completed}/${status.discovery.keywordCounts.total} completed · ${status.discovery.keywordCounts.repairable} repairable`,
    ),
    metricCard(
      'Enrichment',
      status.currentEnrichmentId ? currentEnrichmentState(status) : 'not started',
      status.currentEnrichmentId ?? 'No current enrichment',
    ),
    metricCard(
      'Finalization',
      status.finalization.state,
      `${status.finalization.currentDecisionCount}/${status.finalization.finalistCount} current decisions`,
    ),
    metricCard(
      'Library',
      status.library.published ? 'published' : 'not published',
      status.library.publicationId ?? status.library.reason ?? 'No publication',
    ),
    metricCard('Next action', status.nextAction.code, status.nextAction.message),
  );
}

function currentEnrichmentState(status) {
  return status.enrichments.find((item) => item.enrichmentId === status.currentEnrichmentId)?.state ?? 'unknown';
}

function renderEvidence() {
  elements.evidenceArea.replaceChildren();
  if (state.clusters.length > 0) {
    const section = document.createElement('section');
    section.className = 'card evidence-section';
    const heading = document.createElement('h3');
    heading.textContent = `Current clusters (${state.clusters.length})`;
    const intro = document.createElement('p');
    intro.textContent = 'Read-only projection from the current enrichment generation.';
    const grid = document.createElement('div');
    grid.className = 'cluster-grid';
    for (const cluster of state.clusters) {
      const card = document.createElement('div');
      card.className = 'cluster-card';
      const name = document.createElement('strong');
      name.textContent = `${cluster.clusterId} · ${cluster.canonicalKeyword}`;
      const detail = document.createElement('small');
      detail.textContent = `${cluster.memberCount} member(s) · median volume ${formatNullable(cluster.medianVolume)}`;
      card.append(name, detail);
      grid.append(card);
    }
    section.append(heading, intro, grid);
    elements.evidenceArea.append(section);
  }

  const finalists = evidenceFinalists();
  if (finalists.length > 0) {
    const section = document.createElement('section');
    section.className = 'card evidence-section';
    const heading = document.createElement('h3');
    heading.textContent = `Finalist evidence (${finalists.length})`;
    const intro = document.createElement('p');
    intro.textContent = 'Current published finalist-evidence artifact. Human decisions shown here are read-only.';
    const grid = document.createElement('div');
    grid.className = 'cluster-grid';
    for (const finalist of finalists) {
      const card = document.createElement('div');
      card.className = 'cluster-card';
      const name = document.createElement('strong');
      name.textContent = `${finalist.clusterId} · ${finalist.canonicalKeyword ?? 'unknown'}`;
      const decision = document.createElement('small');
      const human = finalist.humanDecision ?? {};
      decision.textContent = `decision ${human.buildDecision ?? 'unrecorded'} · role ${human.seoProductRole ?? 'unrecorded'}`;
      card.append(name, decision);
      const flags = Array.isArray(finalist.auditFlags) ? finalist.auditFlags : [];
      if (flags.length > 0) {
        const list = document.createElement('div');
        list.className = 'audit-flags';
        for (const flag of flags) {
          const badge = document.createElement('span');
          badge.className = 'audit-flag';
          badge.textContent = flag;
          list.append(badge);
        }
        card.append(list);
      }
      grid.append(card);
    }
    section.append(heading, intro, grid);
    elements.evidenceArea.append(section);
  }
}

function evidenceFinalists() {
  const finalists = state.evidence?.matrix?.finalists;
  return Array.isArray(finalists) ? finalists : [];
}

function suggestedContinuation(plan) {
  const requirements = new Set(plan.unresolvedHumanRequirements ?? []);
  if (requirements.has('shortlist')) return 'shortlist';
  if (requirements.has('finalist_scope')) return 'finalists';
  if (requirements.has('human_decisions')) return 'decisions';
  return 'none';
}

function renderContinuationFields(action) {
  invalidateExistingPlan();
  elements.continuationFields.replaceChildren();
  elements.clusterSelector.replaceChildren();
  elements.clusterSelector.hidden = true;
  elements.decisionEditor.replaceChildren();
  elements.decisionEditor.hidden = true;
  elements.continuationHint.textContent = 'The canonical planner validates this action against the exact current research before Continue is enabled.';

  if (action === 'none') {
    elements.continuationFields.append(infoText('No continuation document. Use this only when the current plan has a resumable or ready stage that needs no new human input.'));
    return;
  }
  if (action === 'finalists' || action === 'finalists_all') {
    if (action === 'finalists') renderClusterSelector();
    else elements.continuationFields.append(infoText('All current clusters will be resolved to a concrete finalist scope by the production executor.'));
    return;
  }
  if (action === 'publication_override') {
    elements.continuationFields.append(infoText('This explicitly requests publication without complete human decisions. The production planner/executor remains the authority on whether this is allowed.'));
    return;
  }
  if (action === 'decisions') {
    renderDecisionEditor();
    return;
  }

  const labels = {
    shortlist: 'Shortlist file',
    representative_overrides: 'Representative overrides JSON',
    traffic: 'Traffic evidence CSV',
  };
  elements.continuationFields.append(fileField(labels[action] ?? 'Continuation file', action));
  if (action === 'traffic') {
    const threshold = document.createElement('label');
    threshold.className = 'field';
    const title = document.createElement('span');
    title.textContent = 'Low-base organic traffic threshold';
    const input = document.createElement('input');
    input.id = 'traffic-threshold';
    input.type = 'number';
    input.min = '0';
    input.value = '100';
    threshold.append(title, input);
    elements.continuationFields.append(threshold);
  }
}

function renderClusterSelector() {
  elements.clusterSelector.hidden = false;
  const title = document.createElement('div');
  title.className = 'selection-title';
  title.textContent = 'Choose finalist clusters';
  elements.clusterSelector.append(title);
  if (state.clusters.length === 0) {
    elements.clusterSelector.append(infoText('No current clusters are available. The canonical planner will reject an invalid finalist scope.'));
    return;
  }
  for (const cluster of state.clusters) {
    const row = document.createElement('div');
    row.className = 'cluster-select-row';
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = cluster.clusterId;
    input.dataset.cluster = cluster.clusterId;
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = `${cluster.clusterId} · ${cluster.canonicalKeyword}`;
    const detail = document.createElement('small');
    detail.textContent = `${cluster.memberCount} member(s) · median volume ${formatNullable(cluster.medianVolume)}`;
    text.append(strong, document.createElement('br'), detail);
    label.append(input, text);
    row.append(label);
    elements.clusterSelector.append(row);
  }
}

function renderDecisionEditor() {
  elements.decisionEditor.hidden = false;
  const title = document.createElement('div');
  title.className = 'selection-title';
  title.textContent = 'Human decisions JSON';
  const hint = document.createElement('p');
  hint.className = 'plan-meta';
  hint.textContent = 'Edit the values directly. The production finalist-decision parser validates every row; the browser does not invent or reinterpret allowed values.';
  const textarea = document.createElement('textarea');
  textarea.id = 'decision-json';
  textarea.rows = Math.min(24, Math.max(8, evidenceFinalists().length * 4));
  textarea.style.width = '100%';
  textarea.style.fontFamily = 'SFMono-Regular, Consolas, monospace';
  textarea.value = JSON.stringify(
    evidenceFinalists().map((finalist) => ({
      clusterId: finalist.clusterId,
      buildDecision: finalist.humanDecision?.buildDecision ?? null,
      seoProductRole: finalist.humanDecision?.seoProductRole ?? null,
    })),
    null,
    2,
  );
  elements.decisionEditor.append(title, hint, textarea);
}

function fileField(labelText, action) {
  const label = document.createElement('label');
  label.className = 'field';
  const title = document.createElement('span');
  title.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'file';
  input.dataset.continuationFile = action;
  label.append(title, input);
  return label;
}

function invalidateExistingPlan() {
  state.existingDraftId = null;
  elements.runExisting.disabled = true;
  elements.existingState.textContent = state.researchId ? 'Not planned' : 'No research';
}

async function planExistingResearch() {
  if (!state.researchId) return;
  hideError(elements.existingError);
  elements.planExisting.disabled = true;
  elements.runExisting.disabled = true;
  elements.existingState.textContent = 'Planning…';
  try {
    const { continuation, files } = await buildContinuationPayload();
    const encoded = encodeURIComponent(state.researchId);
    const planned = await api(`/api/researches/${encoded}/plan`, {
      method: 'POST',
      body: { continuation, files },
    });
    state.existingDraftId = planned.draftId;
    renderPlan(elements.existingPlan, planned.plan);
    elements.existingState.textContent = 'Plan ready';
    elements.runExisting.disabled = !planHasExecutableStage(planned.plan);
  } catch (error) {
    state.existingDraftId = null;
    elements.existingState.textContent = 'Plan failed';
    showError(elements.existingError, error);
  } finally {
    elements.planExisting.disabled = false;
  }
}

async function buildContinuationPayload() {
  const action = elements.continuationAction.value;
  if (action === 'none') return { continuation: null, files: {} };
  const base = { version: 1, researchId: state.researchId };

  if (action === 'finalists') {
    const clusters = [...elements.clusterSelector.querySelectorAll('input[data-cluster]:checked')].map((input) => input.value);
    if (clusters.length === 0) throw new Error('Choose at least one finalist cluster.');
    return { continuation: { ...base, action: { type: action, clusters } }, files: {} };
  }
  if (action === 'finalists_all') {
    return { continuation: { ...base, action: { type: action } }, files: {} };
  }
  if (action === 'publication_override') {
    return { continuation: { ...base, action: { type: action, publishWithoutDecisions: true } }, files: {} };
  }
  if (action === 'decisions') {
    const textarea = byId('decision-json');
    if (!textarea || !textarea.value.trim()) throw new Error('Human decisions JSON is required.');
    const path = 'inputs/decisions.json';
    return {
      continuation: { ...base, action: { type: action, path } },
      files: { [path]: textarea.value },
    };
  }

  const input = elements.continuationFields.querySelector('input[data-continuation-file]');
  const file = input?.files?.[0];
  if (!file) throw new Error(`Choose a file for ${formatToken(action)}.`);
  const extension = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : '.txt';
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.txt';
  const path = `inputs/${action}${safeExtension}`;
  const files = { [path]: await file.text() };
  if (action === 'traffic') {
    const threshold = readNumber(byId('traffic-threshold'), 'Low-base organic traffic threshold');
    return {
      continuation: { ...base, action: { type: action, path, lowBaseOrganicTrafficThreshold: threshold } },
      files,
    };
  }
  return { continuation: { ...base, action: { type: action, path } }, files };
}

async function runExistingResearch() {
  if (!state.researchId) return;
  hideError(elements.existingError);
  elements.planExisting.disabled = true;
  elements.runExisting.disabled = true;
  elements.runExisting.textContent = 'Running…';
  elements.existingState.textContent = 'Running';
  try {
    const encoded = encodeURIComponent(state.researchId);
    const execution = await api(`/api/researches/${encoded}/run`, {
      method: 'POST',
      body: { draftId: state.existingDraftId },
    });
    state.existingDraftId = null;
    renderExecution(elements.existingResult, execution);
    elements.existingState.textContent = execution.exitCode === 0 ? 'Finished' : 'Stopped';
    await refreshResearches();
    await openResearch();
  } catch (error) {
    showError(elements.existingError, error);
    elements.existingState.textContent = 'Run failed';
  } finally {
    elements.planExisting.disabled = false;
    elements.runExisting.textContent = 'Continue';
  }
}

function renderPlan(container, plan) {
  container.replaceChildren();
  const card = document.createElement('section');
  card.className = 'card plan-card';
  const header = document.createElement('div');
  header.className = 'plan-header';
  const headingWrap = document.createElement('div');
  const heading = document.createElement('h3');
  heading.textContent = `${plan.stateContext?.kind === 'existing' ? 'Existing' : 'New'} research plan`;
  const meta = document.createElement('div');
  meta.className = 'plan-meta';
  meta.textContent = `Stop point: ${plan.expectedStopPoint ?? 'unknown'} · fingerprint ${shortFingerprint(plan.effectiveConfigFingerprint)}`;
  headingWrap.append(heading, meta);
  const preset = document.createElement('span');
  preset.className = 'state-chip';
  const presetIdentity = plan.preset ?? plan.semantics?.preset ?? null;
  preset.textContent = presetIdentity ? `${presetIdentity.id}@${presetIdentity.revision}` : 'No preset';
  header.append(headingWrap, preset);

  const stages = document.createElement('div');
  stages.className = 'stage-grid';
  for (const stage of plan.stages ?? []) {
    const stageCard = document.createElement('div');
    stageCard.className = 'stage-card';
    const title = document.createElement('div');
    title.className = 'stage-title';
    const name = document.createElement('span');
    name.textContent = stage.id;
    const badge = document.createElement('span');
    badge.className = `badge badge-${stage.state}`;
    badge.textContent = stage.state;
    title.append(name, badge);
    const reason = document.createElement('p');
    reason.textContent = stage.reason ?? 'No additional gate.';
    stageCard.append(title, reason);
    stages.append(stageCard);
  }
  card.append(header, stages);

  const requirements = plan.unresolvedHumanRequirements ?? [];
  if (requirements.length > 0) {
    const gates = document.createElement('div');
    gates.className = 'human-gates';
    gates.textContent = `Human input required: ${requirements.join(', ')}`;
    card.append(gates);
  }
  if ((plan.externalWork ?? []).length > 0) {
    const work = document.createElement('div');
    work.className = 'human-gates';
    work.textContent = `External work: ${plan.externalWork.map((item) => item.provider ?? item.type ?? JSON.stringify(item)).join(', ')}`;
    card.append(work);
  }

  const details = document.createElement('details');
  details.className = 'json-details';
  const summary = document.createElement('summary');
  summary.textContent = 'Machine-readable plan';
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(plan, null, 2);
  details.append(summary, pre);
  card.append(details);
  container.append(card);
}

function renderExecution(container, execution) {
  container.replaceChildren();
  const result = execution.result ?? {};
  const card = document.createElement('section');
  card.className = `card result-card ${execution.exitCode === 0 ? 'success' : 'failure'}`;
  const heading = document.createElement('h3');
  heading.textContent = execution.exitCode === 0 ? 'Execution finished' : 'Execution stopped';
  const detail = document.createElement('div');
  detail.className = 'plan-meta';
  detail.textContent = `exit ${execution.exitCode} · ${result.workflowState ?? 'unknown'} · stop ${result.stopPoint ?? 'unknown'}`;
  const list = document.createElement('dl');
  list.className = 'result-list';
  for (const [label, value] of [
    ['researchId', result.researchId],
    ['discovery', result.discoveryState],
    ['enrichment', result.enrichmentState],
    ['finalization', result.finalizationState],
    ['publicationId', result.publicationId],
    ['human requirements', (result.unresolvedHumanRequirements ?? []).join(', ') || 'none'],
  ]) {
    const wrap = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value ?? '—';
    wrap.append(dt, dd);
    list.append(wrap);
  }
  card.append(heading, detail, list);
  container.append(card);
}

function metricCard(label, value, detail) {
  const card = document.createElement('section');
  card.className = 'card metric-card';
  const labelNode = document.createElement('div');
  labelNode.className = 'metric-label';
  labelNode.textContent = label;
  const valueNode = document.createElement('div');
  valueNode.className = 'metric-value';
  valueNode.textContent = value ?? '—';
  const detailNode = document.createElement('div');
  detailNode.className = 'metric-detail';
  detailNode.textContent = detail ?? '';
  card.append(labelNode, valueNode, detailNode);
  return card;
}

function infoText(text) {
  const node = document.createElement('div');
  node.className = 'metric-detail';
  node.textContent = text;
  return node;
}

function planHasExecutableStage(plan) {
  return (plan.stages ?? []).some((stage) => stage.state === 'ready');
}

async function api(path, options = {}) {
  const init = { method: options.method ?? 'GET', headers: {} };
  if (Object.prototype.hasOwnProperty.call(options, 'body')) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload?.error?.code ? `${payload.error.code}: ` : '';
    throw new Error(`${code}${payload?.error?.message ?? `HTTP ${response.status}`}`);
  }
  return payload;
}

function showError(element, error) {
  element.hidden = false;
  element.textContent = error instanceof Error ? error.message : String(error);
}

function hideError(element) {
  element.hidden = true;
  element.textContent = '';
}

function fillSelect(select, values) {
  select.replaceChildren();
  for (const value of values) addOption(select, value, formatToken(value));
}

function addOption(select, value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.append(option);
}

function hasOption(select, value) {
  return [...select.options].some((option) => option.value === value);
}

function addOverride(target, key, value, baseValue) {
  if (value !== baseValue) target[key] = value;
}

function diffObject(current, base) {
  return Object.fromEntries(Object.entries(current).filter(([key, value]) => value !== base[key]));
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readNumber(input, label) {
  const value = Number(input?.value);
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}

function formatToken(value) {
  return String(value).replaceAll('_', ' ');
}

function formatNullable(value) {
  return value === null || value === undefined ? 'unknown' : String(value);
}

function shortFingerprint(value) {
  if (!value) return 'n/a';
  return String(value).slice(0, 12);
}
