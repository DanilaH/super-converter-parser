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
    """      } catch (error) {
        throw new ResearchError(
          'DB_ERROR',
          `Run store schema migration v${version + 1} failed; the database was left at v${current}.`,
          { cause: error },
        );
      }
""",
    """      } catch (error) {
        // Migrations commit one version at a time. Earlier versions in this open
        // may already be durable, so report the actual persisted version rather
        // than the version observed before the migration loop started.
        const persistedVersion = this.db.pragma('user_version', { simple: true }) as number;
        throw new ResearchError(
          'DB_ERROR',
          `Run store schema migration v${version + 1} failed; the database was left at v${persistedVersion}.`,
          { cause: error },
        );
      }
""",
    "migration failure version reporting",
)
store.write_text(text, encoding="utf-8")


tests = Path("src/db/store.test.ts")
text = tests.read_text(encoding="utf-8")
marker = "\ntest('a current-version store repairs missing dynamic columns on reopen', async () => {"
regression = r'''

test('a later migration failure reports the version already persisted by earlier migrations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-migrate-partial-progress-'));
  const path = join(directory, 'run.sqlite');
  const v1 = new Database(path);
  v1.pragma('user_version = 1');
  v1.exec(V1_SCHEMA);
  // v5 creates related_keywords without IF NOT EXISTS. Pre-create the table so
  // v2-v4 can commit normally and v5 then fails deterministically.
  v1.exec('CREATE TABLE related_keywords (sentinel TEXT)');
  v1.close();

  assert.throws(
    () => RunStore.open(path),
    (error: unknown) =>
      error instanceof ResearchError &&
      error.code === 'DB_ERROR' &&
      error.message.includes('migration v5 failed') &&
      error.message.includes('left at v4'),
  );

  const raw = new Database(path, { readonly: true });
  assert.equal(raw.pragma('user_version', { simple: true }), 4);
  raw.close();
});
'''
if text.count(marker) != 1:
    raise SystemExit(f"unexpected migration review insertion marker: {text.count(marker)} matches")
text = text.replace(marker, regression + marker)
tests.write_text(text, encoding="utf-8")
