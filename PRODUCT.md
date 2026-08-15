# PRODUCT.md

## Problem

Current SEO opportunity research requires too much repetitive browser work.

The manual loop looks like:

```text
candidate keyword
→ Google
→ read Keyword Surfer
→ inspect SERP
→ open Ahrefs
→ check domains
→ repeat dozens or hundreds of times
```

This makes broad falsification expensive and encourages premature focus on a small number of ideas.

## Goal

Build a local CLI that automatically gathers enough observable data to eliminate obvious bad opportunities and surface anomalies worth deeper manual research.

The tool must reduce something like:

```text
200–500 raw intents
        ↓
automatic collection + filtering
        ↓
20–40 interesting opportunities
        ↓
manual deep research
        ↓
5–10 finalists
```

## What the tool decides

The tool may automatically calculate observable signals:

- search volume;
- CPC;
- Microsoft volume bucket;
- related keyword volume/overlap;
- SERP composition;
- DR distribution;
- weak/strong-domain counts;
- exact/niche-domain indicators;
- deterministic opportunity score.

## What the tool does NOT decide

The runner must not autonomously decide:

- whether a product should definitely be built;
- implementation complexity;
- monetization viability;
- legal/regulatory risk;
- whether search intent is genuinely useful;
- final BUILD / WATCH / KILL.

Those require human/agent analysis after collection.

## Users

Primary users:

1. human operator;
2. local coding/research agent capable of launching CLI commands and reading result files.

The tool must work equally well for both.

## Core workflows

### Workflow A — Broad discovery

```text
generated seeds
→ Microsoft Keyword Planner bulk upload
→ Microsoft CSV export
→ runner
→ Surfer + Google SERP
→ Ahrefs DR
→ shortlist
```

Microsoft remains a deliberate first-stage discovery source. It is not removed from the research methodology.

### Workflow B — Fast direct research

```text
small seed CSV
→ runner
→ optional Surfer related-keyword expansion
→ Google + Surfer
→ Ahrefs DR
→ shortlist
```

This is useful when researching a specific family without another Microsoft pass.

### Workflow C — Resume

If the process stops after 137/200 keywords:

```text
restart
→ load existing run state
→ reuse cache/checkpoints
→ continue unfinished work
```

Completed expensive work must not be repeated unnecessarily.

## Non-goals

Do not build in v1:

- dashboard;
- React/Next.js frontend;
- hosted web app;
- accounts;
- multi-user support;
- server/API product;
- proxy network;
- CAPTCHA bypass;
- anti-bot evasion;
- Ahrefs UI scraping;
- Similarweb UI scraping;
- automated Microsoft Ads browser scraping;
- LLM-based scoring;
- scheduler/daemon;
- Redis/queue infrastructure.
