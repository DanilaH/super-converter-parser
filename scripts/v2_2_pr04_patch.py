from pathlib import Path

root = Path.cwd()

status_path = root / 'src/research/status.ts'
status = status_path.read_text(encoding='utf-8')

status = status.replace(
    "import { entrantCohortFingerprint } from '../db/cohortHistory.js';\n",
    "import { entrantCohortFingerprint, loadCohortHistoryState } from '../db/cohortHistory.js';\n"
    "import { loadTrafficEvidencePolicy, loadTrafficImportRecords } from '../db/trafficEvidence.js';\n",
    1,
)
status = status.replace(
    "import { buildResearchLibrarySnapshot } from '../library/researchLibrary.js';\n",
    "import { buildResearchLibrarySnapshot } from '../library/researchLibrary.js';\n"
    "import { projectCurrentTrafficEvidence } from '../enrichment/trafficEvidenceCurrent.js';\n"
    "import { projectDeepEvidenceCoverage, type DeepEvidenceCoverage } from './evidenceCoverage.js';\n",
    1,
)
status = status.replace("  version: '1.0.0';\n", "  version: '1.1.0';\n", 1)
status = status.replace(
    "  library: LibraryPublicationStatus;\n  nextAction: ResearchNextAction;\n",
    "  library: LibraryPublicationStatus;\n  evidenceCoverage: DeepEvidenceCoverage | null;\n  nextAction: ResearchNextAction;\n",
    1,
)

marker = "export async function inspectLibraryPublication(\n"
coverage_fn = """async function inspectEvidenceCoverage(
  researchDirectory: string,
  enrichment: ResearchEnrichmentStatus | null,
  finalization: FinalizationStatus,
): Promise<DeepEvidenceCoverage | null> {
  if (!enrichment) return null;
  const store = RunStore.openReadOnly(join(researchDirectory, enrichment.directoryName, 'enrichment.sqlite'));
  try {
    const representatives = loadRepresentativeQueryState(store, enrichment.enrichmentId);
    const entrant = loadEntrantCohortState(store, enrichment.enrichmentId);
    const history = loadCohortHistoryState(store, enrichment.enrichmentId);
    const trafficPolicy = loadTrafficEvidencePolicy(store, enrichment.enrichmentId);
    const trafficRecords = loadTrafficImportRecords(store, enrichment.enrichmentId);
    const currentTraffic = entrant !== null && trafficPolicy !== null
      ? projectCurrentTrafficEvidence({
          importedSnapshots: trafficRecords.map((record) => record.snapshot),
          cohorts: entrant.cohorts,
          policy: trafficPolicy,
        })
      : null;

    return projectDeepEvidenceCoverage({
      representatives: representatives?.sets ?? null,
      cohorts: entrant?.cohorts ?? null,
      history: history?.projections ?? null,
      traffic: {
        importedSnapshotCount: trafficRecords.length,
        policyAvailable: trafficPolicy !== null,
        current: currentTraffic,
      },
      finalistMatrixPublished: finalization.finalistMatrixPublished,
    });
  } finally {
    store.close();
  }
}

"""
if marker not in status:
    raise SystemExit('status library marker not found')
status = status.replace(marker, coverage_fn + marker, 1)

old_finalization_tail = """    : await inspectFinalization(target.researchDirectory, currentEnrichment);
  const library = target.legacy
"""
new_finalization_tail = """    : await inspectFinalization(target.researchDirectory, currentEnrichment);
  const evidenceCoverage = target.legacy
    ? null
    : await inspectEvidenceCoverage(target.researchDirectory, currentEnrichment, finalization);
  const library = target.legacy
"""
if old_finalization_tail not in status:
    raise SystemExit('status finalization insertion point not found')
status = status.replace(old_finalization_tail, new_finalization_tail, 1)
status = status.replace("    version: '1.0.0',\n", "    version: '1.1.0',\n", 1)
status = status.replace(
    "    finalization,\n    library,\n    nextAction: nextActionFor({\n",
    "    finalization,\n    library,\n    evidenceCoverage,\n    nextAction: nextActionFor({\n",
    1,
)
status_path.write_text(status, encoding='utf-8')

cli_path = root / 'src/cli/researchStatus.ts'
cli = cli_path.read_text(encoding='utf-8')

module_marker = "export function renderResearchStatus(status: ResearchStatus): string {\n"
helper = """function coverageLine(value: { numerator: number; denominator: number } | null): string {
  return value === null ? 'n/a' : `${value.numerator}/${value.denominator}`;
}

"""
if module_marker not in cli:
    raise SystemExit('researchStatus render marker not found')
cli = cli.replace(module_marker, helper + module_marker, 1)

old_section = """  if (status.finalization.artifactWarning) lines.push(`  Artifact warning: ${status.finalization.artifactWarning}`);

  lines.push('', 'Research Library');
"""
new_section = """  if (status.finalization.artifactWarning) lines.push(`  Artifact warning: ${status.finalization.artifactWarning}`);

  lines.push('', 'Deep evidence coverage');
  if (status.evidenceCoverage === null) {
    lines.push('  unavailable');
  } else {
    const coverage = status.evidenceCoverage;
    lines.push(`  Representative URL identity: ${coverageLine(coverage.representativeUrlCoverage)}`);
    lines.push(`  Entrant DR known: ${coverageLine(coverage.drKnownCoverage)}`);
    lines.push(`  Page identity: ${coverageLine(coverage.pageIdentityCoverage)}`);
    if (coverage.history !== null) {
      lines.push(`  History checked: ${coverageLine(coverage.history.checkedCoverage)}`);
      lines.push(`  RDAP registration known: ${coverageLine(coverage.history.registrationKnownCoverage)}`);
      lines.push(`  Web first-seen known: ${coverageLine(coverage.history.firstSeenKnownCoverage)}`);
      lines.push(`  History omitted/unobserved: ${coverage.history.omittedDomainCount}/${coverage.history.unobservedDomainCount}`);
    }
    if (coverage.traffic !== null) {
      lines.push(`  Traffic snapshots imported: ${coverage.traffic.importedSnapshotCount}`);
      lines.push(`  Matched domain-scope traffic: ${coverageLine(coverage.traffic.matchedDomainCoverage)}`);
    }
    if (coverage.warnings.length === 0) {
      lines.push('  Coverage warnings: none');
    } else {
      lines.push(`  Coverage warnings: ${coverage.warnings.length}`);
      for (const warning of coverage.warnings) {
        lines.push(`    - ${warning.code}: ${warning.message}`);
      }
    }
  }

  lines.push('', 'Research Library');
"""
if old_section not in cli:
    raise SystemExit('researchStatus finalization section not found')
cli = cli.replace(old_section, new_section, 1)
cli_path.write_text(cli, encoding='utf-8')

readme_path = root / 'README.md'
readme = readme_path.read_text(encoding='utf-8')
old_readme = """`research:status` is read-only. It resolves the logical research to `research.json.currentRunId` and reports the current discovery generation, keyword completion/repairability, existing quality warnings, immutable enrichment generations and module state, finalization/human-decision progress, and whether the **current exact public snapshot fingerprint** already exists in the Research Library. It never resumes, repairs, finalizes, publishes, or rewrites state.

Use `--json` for the machine-readable projection. The displayed next action is workflow navigation only; it is not a business or opportunity recommendation.
"""
new_readme = """`research:status` is read-only. It resolves the logical research to `research.json.currentRunId` and reports the current discovery generation, keyword completion/repairability, existing quality warnings, immutable enrichment generations and module state, finalization/human-decision progress, and whether the **current exact public snapshot fingerprint** already exists in the Research Library. It also projects deep evidence coverage from current durable representative/cohort/history/traffic state, keeping omitted, unobserved, unavailable, mismatched, and missing evidence explicit instead of converting it to zero or negative evidence. It never resumes, repairs, finalizes, publishes, or rewrites state.

Use `--json` for the machine-readable projection. Deep coverage warning codes are deterministic uncertainty/navigation facts; the finalist evidence matrix remains the detailed generated artifact with its existing coverage blocks and audit flags. The displayed next action is workflow navigation only; it is not a business or opportunity recommendation.
"""
if old_readme not in readme:
    raise SystemExit('README status paragraph not found')
readme_path.write_text(readme.replace(old_readme, new_readme, 1), encoding='utf-8')
