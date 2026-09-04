# PRODUCT.md

## Product

**Utility Research Runner** is a local-first internal research tool for discovering and validating SEO opportunities for small browser utilities.

Its purpose is to remove repetitive evidence collection so broad opportunity spaces can be falsified cheaply before expensive manual product research begins.

## Problem

Manual SEO opportunity research tends to repeat the same loop:

```text
candidate keyword
→ Google
→ Keyword Surfer / demand evidence
→ inspect organic SERP
→ inspect domain strength/history
→ compare related queries
→ repeat dozens or hundreds of times
```

That makes broad exploration expensive and encourages premature commitment to a few hand-picked ideas.

## Goal

The runner should turn large, messy intent spaces into auditable evidence that helps the operator decide what deserves deeper investigation.

Conceptually:

```text
broad seed / keyword space
        ↓
automatic collection + bounded expansion
        ↓
structured discovery evidence
        ↓
deep enrichment for an explicit shortlist
        ↓
finalist evidence for explicit clusters
        ↓
human decision
```

The runner optimizes **research throughput and evidence quality**, not automatic business decision-making.

## Primary users

1. Human operator.
2. Local coding/research agent capable of launching CLI commands and reading machine-readable artifacts.

The tool should remain usable by both without requiring a hosted dashboard.

## What the runner may automate

The runner may collect, normalize, persist, compare, and project observable facts such as:

- search volume and CPC proxies;
- Google organic SERP evidence;
- explicit source-specific SERP success/failure state;
- Keyword Surfer Related observations;
- deterministic bounded expansion admission;
- domain normalization and Ahrefs DR where configured;
- broad-discovery score inputs;
- clustering and query-suggestion evidence;
- registration / first-seen / sampled historical-presence evidence;
- entrant repetition across representative queries;
- page/site-structure observations;
- optional imported traffic evidence;
- immutable generation differences;
- evidence coverage, omissions, errors, and stale-parent state;
- publication lineage.

## What the runner must not decide

The runner must not autonomously decide:

- whether a product should definitely be built;
- whether an SEO opportunity is commercially viable;
- implementation or production complexity;
- legal/regulatory suitability;
- final search-intent usefulness;
- launch-success probability;
- final `build | watch | reject | unknown` decision;
- product role or monetization strategy.

Those are human/agent interpretation tasks after evidence collection.

## Core workflows

### 1. Broad discovery

```text
seeds or Microsoft Keyword Planner export
        ↓
Google + Keyword Surfer
        ↓
optional bounded Expansion Admission V1
        ↓
optional Ahrefs DR
        ↓
ranked / inspectable discovery evidence
```

Microsoft remains a supported first-stage discovery source. It is not required for direct seed research.

### 2. Config-first research orchestration

```text
OperatorResearchConfig
        ↓
read-only research:plan
        ↓
research:run
        ↓
stable researchId
        ↓
explicit continuation through human gates
```

This is the accepted normal orchestration layer. It must reuse existing durable stage semantics rather than becoming a parallel workflow implementation.

### 3. Append / iterative discovery

A logical research can receive later seed batches without creating a new top-level project.

Append creates immutable combined discovery generations when new keywords are added or an expansion child is explicitly promoted into a root.

### 4. Deep enrichment

An explicit shortlist may be enriched with clustering, query suggestions, domain age/history, page evidence, and site-structure evidence.

Deep work remains bounded and resumable.

### 5. Finalist validation

Explicit finalist clusters flow through:

```text
representative queries
→ entrant cohort
→ bounded sampled historical presence
→ cohort history
→ optional traffic evidence
→ finalist evidence matrix
→ human decision
```

Evidence blocks remain separable; missing evidence is not converted into a negative verdict.

### 6. Research Library

Reviewed/current research snapshots may be published into an immutable cumulative library with superseding version history.

Publication does not change the underlying research evidence and does not fabricate missing human decisions.

## Product principles

### Evidence honesty

```text
missing != zero
unknown != negative
not_found != unavailable
error != empty
omitted != measured
```

### Durable reproducibility

SQLite owns resume/currentness truth. Generated artifacts are projections.

### Immutable history

Older discovery/enrichment/publication generations are preserved instead of silently rewritten.

### Explicit human gates

The runner stops when a shortlist, finalist scope, decision, or another genuinely human input is required.

### Bounded automation

Provider work, expansion, retries, and expensive enrichment must have explicit limits.

### Scope discipline

Add complexity only when it improves actual research value, evidence truthfulness, maintainability, or operator efficiency.

## Current non-goals

Do not add by default:

- hosted SaaS architecture;
- accounts or multi-user support;
- remote database infrastructure;
- Redis / distributed queues;
- generic provider/plugin framework;
- CAPTCHA bypass or anti-detection stack;
- Ahrefs/Similarweb UI scraping;
- LLM-based opportunity scoring;
- automatic product recommendations;
- recursive unbounded Related expansion;
- a large dashboard;
- a local GUI unless explicitly revisited;
- V3 commercial-evidence collection unless that future track is explicitly activated.

## Success criterion

The runner is successful when it lets the operator explore materially broader opportunity spaces with less repetitive manual work **without making the evidence less trustworthy or hiding uncertainty**.