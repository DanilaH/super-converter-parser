# Operator presets

Presets are versioned semantic overlays for `OperatorResearchConfigV1`. They reduce repeated research settings without creating a second workflow model.

Use a preset by id:

```json
{
  "version": 1,
  "preset": "standard",
  "research": {
    "label": "json-tools",
    "input": { "type": "seeds", "path": "input/seeds.csv" }
  }
}
```

Merge order is deterministic:

```text
schema defaults < preset overlay < research config
```

Objects merge recursively. Arrays replace the inherited array completely. Missing fields inherit. Presets cannot contain research input paths, shortlist/finalist choices, human decisions, traffic files, publication overrides, secrets, or machine/runtime settings.

Curated v1 presets:

- `quick-scan` — discovery only, no expansion, optional Ahrefs.
- `standard` — expanded discovery plus clustering and bounded query suggestions; stops for an explicit shortlist before enrichment work that requires one.
- `deep-research` — expanded discovery, full enrichment modules, then the accepted finalization policy; human finalist/decision gates remain mandatory.
- `finalist-validation` — expanded discovery plus clustering, then stops at the explicit finalist scope gate before finalization.

`research:plan` shows the resolved `id@revision` and semantic origin (`default`, `preset`, or `file`) of effective values. When a research starts, the exact preset overlay snapshot is persisted in immutable `operator-config.json`; later edits to a preset file do not reinterpret existing research.
