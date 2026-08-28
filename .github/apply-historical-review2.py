from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"unexpected {label} shape: {count} matches")
    return text.replace(old, new)


store = Path("src/db/store.ts")
text = store.read_text(encoding="utf-8")
text = replace_once(
    text,
    "private tableColumns(table: 'runs' | 'keywords' | 'serp_rows'): Set<string>",
    "private tableColumns(table: 'runs' | 'keywords' | 'serp_rows' | 'related_keywords'): Set<string>",
    "tableColumns union",
)
text = replace_once(
    text,
    "  loadRelatedKeywords(runId: string): StoredRelatedKeyword[] {\n    return (\n",
    "  loadRelatedKeywords(runId: string): StoredRelatedKeyword[] {\n    // v1-v4 discovery stores predate persisted related-keyword provenance.\n    // In read-only enrichment that absence means there is no reusable source-run\n    // Surfer collection; callers may collect the source normally instead.\n    if (this.tableColumns('related_keywords').size === 0) return [];\n    return (\n",
    "loadRelatedKeywords fallback",
)
store.write_text(text, encoding="utf-8")


tests = Path("src/db/store.test.ts")
text = tests.read_text(encoding="utf-8")
text = replace_once(
    text,
    "  assert.equal(source.loadKeywords('run-1')[0]?.cacheStatus, null);\n  const serp = source.loadSerpRows('run-1');\n",
    "  assert.equal(source.loadKeywords('run-1')[0]?.cacheStatus, null);\n  assert.deepEqual(source.loadRelatedKeywords('run-1'), []);\n  const serp = source.loadSerpRows('run-1');\n",
    "v1 related keywords assertion",
)
tests.write_text(text, encoding="utf-8")


readme = Path("README.md")
text = readme.read_text(encoding="utf-8")
text = replace_once(
    text,
    "for later optional columns, and derives a missing registrable domain from the stored\nhostname/URL. Source stores from a newer schema version are refused explicitly.\n",
    "for later optional columns, treats pre-v5 related-keyword provenance as unavailable,\nand derives a missing registrable domain from the stored hostname/URL. Source stores\nfrom a newer schema version are refused explicitly.\n",
    "README compatibility detail",
)
readme.write_text(text, encoding="utf-8")
