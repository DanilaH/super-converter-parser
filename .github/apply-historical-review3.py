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
    "export class RunStore {\n  private readonly db: Database.Database;\n\n  private constructor(db: Database.Database) {\n    this.db = db;\n  }\n",
    "export class RunStore {\n  private readonly db: Database.Database;\n  private readonly readOnlySource: boolean;\n\n  private constructor(db: Database.Database, readOnlySource = false) {\n    this.db = db;\n    this.readOnlySource = readOnlySource;\n  }\n",
    "RunStore constructor",
)
text = replace_once(
    text,
    "      const store = new RunStore(db);\n      store.assertReadableDiscoverySchema();\n",
    "      const store = new RunStore(db, true);\n      store.assertReadableDiscoverySchema();\n",
    "openReadOnly mode",
)
text = replace_once(
    text,
    "    const columns = this.tableColumns('serp_rows');\n    const hasRegistrableDomainColumn = columns.has('registrable_domain');\n",
    "    // Only immutable source stores may adapt missing historical columns.\n    // Writable/current stores keep the strict schema contract so corruption is\n    // not silently reinterpreted as historical data.\n    const columns = this.readOnlySource ? this.tableColumns('serp_rows') : null;\n    const hasRegistrableDomainColumn = columns === null || columns.has('registrable_domain');\n",
    "SERP read-only column mode",
)
text = replace_once(
    text,
    "    const drExpr = columns.has('dr') ? 'dr' : 'NULL AS dr';\n    const drStatusExpr = columns.has('dr_status') ? 'dr_status' : 'NULL AS dr_status';\n    const drErrorExpr = columns.has('dr_error') ? 'dr_error' : 'NULL AS dr_error';\n",
    "    const drExpr = columns === null || columns.has('dr') ? 'dr' : 'NULL AS dr';\n    const drStatusExpr = columns === null || columns.has('dr_status') ? 'dr_status' : 'NULL AS dr_status';\n    const drErrorExpr = columns === null || columns.has('dr_error') ? 'dr_error' : 'NULL AS dr_error';\n",
    "SERP strict writable expressions",
)
text = replace_once(
    text,
    "    if (this.tableColumns('related_keywords').size === 0) return [];\n",
    "    if (\n      this.readOnlySource &&\n      this.version < 5 &&\n      this.tableColumns('related_keywords').size === 0\n    ) return [];\n",
    "related keywords read-only fallback",
)
store.write_text(text, encoding="utf-8")


tests = Path("src/db/store.test.ts")
text = tests.read_text(encoding="utf-8")
marker = "\ntest('openReadOnly refuses discovery stores from a newer schema version', async () => {"
regression = """

test('writable stores do not hide missing current-schema related keyword tables', () => {
  const store = RunStore.openInMemory();
  const db = (store as unknown as { db: Database.Database }).db;
  db.exec('DROP TABLE related_keywords');
  assert.throws(() => store.loadRelatedKeywords('run-1'));
  store.close();
});
"""
if text.count(marker) != 1:
    raise SystemExit(f"unexpected writable strictness insertion marker: {text.count(marker)} matches")
text = text.replace(marker, regression + marker)
tests.write_text(text, encoding="utf-8")
