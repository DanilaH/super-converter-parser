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
    "    if (current === MIGRATIONS.length) return;\n    for (let version = current; version < MIGRATIONS.length; version += 1) {\n",
    "    // `user_version` only records the ordered migration sequence. The dynamic\n    // repair phase below is deliberately idempotent and must still run when the\n    // version is already current: a previous open may have advanced user_version\n    // before a later repair step was interrupted or failed.\n    for (let version = current; version < MIGRATIONS.length; version += 1) {\n",
    "current-version early return",
)
store.write_text(text, encoding="utf-8")


tests = Path("src/db/store.test.ts")
text = tests.read_text(encoding="utf-8")
marker = "\ntest('a run store from a newer schema version is refused', async () => {"
regression = r'''

test('a current-version store repairs missing dynamic columns on reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-repair-current-'));
  const path = join(directory, 'run.sqlite');

  const created = RunStore.open(path);
  assert.equal(created.version, SCHEMA_VERSION);
  created.close();

  const damaged = new Database(path);
  assert.equal(damaged.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  damaged.exec('ALTER TABLE serp_rows DROP COLUMN dr_error');
  const beforeColumns = damaged.prepare('PRAGMA table_info(serp_rows)').all() as Array<{ name: string }>;
  assert.ok(!beforeColumns.some((column) => column.name === 'dr_error'));
  // Simulate an interrupted post-migration repair: schema version is already
  // current even though one idempotently repairable column is missing.
  assert.equal(damaged.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  damaged.close();

  const repaired = RunStore.open(path);
  assert.equal(repaired.version, SCHEMA_VERSION);
  const db = (repaired as unknown as { db: Database.Database }).db;
  const afterColumns = db.prepare('PRAGMA table_info(serp_rows)').all() as Array<{ name: string }>;
  assert.ok(afterColumns.some((column) => column.name === 'dr_error'));
  repaired.close();
});
'''
if text.count(marker) != 1:
    raise SystemExit(f"unexpected migration test insertion marker: {text.count(marker)} matches")
text = text.replace(marker, regression + marker)
tests.write_text(text, encoding="utf-8")
