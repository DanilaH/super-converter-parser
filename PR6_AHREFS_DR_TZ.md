# PR6 — Domain normalization & Ahrefs DR: Требования и ТЗ

Статус: черновик ТЗ для следующей фазы (IMPLEMENTATION_PLAN.md §PR6, ARCHITECTURE.md §Ahrefs/§Data model).

## 1. Цель и рамки

Добавить нормализацию регистрируемого домена (registrable domain, PSL-aware) и официальный Ahrefs Domain Rating (DR) адаптер с кэшем, дедупом и обработкой rate-limit/ошибок.

В рамках PR6 (НЕ входит):
- скоринг/агрегация (PR7);
- изменение источников keyword (seed/microsoft/surfer_related) — это уже сделано в PR8/PR9/PR10;
- Microsoft/Surfer expansion логика.

## 2. Исходное состояние (проверено в коде)

- **Domain cache УЖЕ реализован** в `src/cache/store.ts`: `getDomain(domain)`, `putDomain(domain, entry, storedAt, ttlMs)`, тип `CachedDomainEntry`, TTL `domainOkMs`/`domainNotFoundMs`/`domainErrorMs` в `config.ts`, ключ `buildDomainCacheKey` в `src/cache/keys.ts`. PR6 **использует** готовый кэш, не создаёт новый.
- `SerpResult` (`src/google/serp.ts`) сейчас: `{ keyword, position, title, url, hostname, resultType }`. **Нет** `registrableDomain` и `dr`.
- Таблица `serp_rows` (`src/db/store.ts`) не хранит `dr`/`registrable_domain`.
- `src/ahrefs/` и `src/domains/` — **не существуют**, создать с нуля.
- `RunManifest.progress` в `run.ts` не содержит `totalDomains`/`completedDomains` (ARCHITECTURE требует).

## 3. Функциональные требования

### 3.1 Нормализация домена (`src/domains/normalize.ts`)
- `registrableDomain(hostname: string): string | null` — извлекает registrable domain по Public Suffix List (напр. `a.b.co.uk` → `b.co.uk`, `example.com` → `example.com`).
- Корректно обрабатывает: IP-адреса (→ `null`), `localhost`, пустые/некорректные значения (→ `null`), trailing dot, mixed case (нормализация в lower-case).
- Чистая функция (без I/O) — юнит-тесты без сети.

### 3.2 Ahrefs DR адаптер (`src/ahrefs/client.ts`)
- Изолированный адаптер к **официальному free DR endpoint** (не UI-скрапинг).
- Вход: нормализованный registrable domain. Выход: `DomainRatingResult` (ARCHITECTURE):
  ```ts
  type DomainRatingResult = { domain: string; dr: number | null; fetchedAt: string; source: "ahrefs"; status: "ok" | "not_found" | "error" };
  ```
- Аутентификация **только** через `AHREFS_API_KEY` из env (никогда не коммитить, никогда не класть в `configSnapshot` как значение — см. §3.7).
- Обработка:
  - `404`/`not found` → `status: "not_found"`, `dr: null`;
  - `429`/`5xx` → `AHREFS_RATE_LIMIT`/`AHREFS_ERROR` с единичным retry + экспоненциальный backoff + jitter (как для keyword, через существующий retry-механизм или локальный);
  - сетевой сбой → `AHREFS_ERROR`, не убивает run (error isolation, ARCHITECTURE).

### 3.3 Использование domain cache
- Перед вызовом API — `cache.getDomain(key)` (с учётом TTL). Попадание → берём `dr` из кэша.
- Промах/просрочено → вызываем адаптер, затем `cache.putDomain(key, { dr, status, error }, now, ttl)` где `ttl` = `domainOkMs`/`domainNotFoundMs`/`domainErrorMs` по статусу.
- **Глобальный дедуп**: `domain_cache` персистентен между runs → повторяющиеся домены по всему набору (и между запусками) дают **один fresh lookup на TTL-окно**. Это удовлетворяет acceptance "Repeated domains trigger one fresh lookup per TTL window".

### 3.4 Интеграция в engine (`src/runs/engine.ts`)
- После получения `result.serpRows` для keyword: вычислить `registrableDomain` для каждой строки (в `buildOrganicResults` или отдельно), собрать уникальные домены keyword.
- DR-фаза (per-keyword, ДО `commitKeyword`): для каждого уникального домена — cache lookup → при промахе API lookup (с `minDelayMs` между вызовами), обогатить `serpRows[i].dr`.
- Затем `commitKeyword(runId, committed, enrichedSerpRows, cacheStatus)` — `serp_rows` сохраняет `registrable_domain` и `dr`.
- Доменный прогресс: инкремент `completedDomains` в manifest по мере обработки уникальных доменов (или считать итогово в конце).

### 3.5 Схема БД (`src/db/store.ts`)
- Миграция `SCHEMA_VERSION` 2 → 3: добавить колонки `registrable_domain TEXT` и `dr REAL` в `serp_rows`.
- `commitKeyword`/`loadSerpRows` — принимать и отдавать `registrableDomain`/`dr` (обновить тип `SerpResult`).
- НЕ трогать таблицу `domain_cache` (уже есть).

### 3.6 Конфиг (`src/config/config.ts`)
- Новый блок `ahrefs: { rateLimitMinDelayMs: number; rateLimitMaxDelayMs: number; timeoutMs: number }` (env `AHREFS_MIN_DELAY_MS` и т.п.).
- Опционально `drThresholds` (veryWeak/weak/strong/veryStrong) — перенести из ARCHITECTURE (нужны для PR7, но можно завести сейчас как константы).
- Токен **не** в config-объекте (читается из env в рантайме).

### 3.7 Секреты и вывод
- `AHREFS_API_KEY` только из env. При отсутствии ключа DR-фаза **тихо пропускается** (`dr=null`), run завершается нормально.
- `configSnapshot` в `manifest.json` НЕ содержит токен (сохраняем `ahrefs: { configured: boolean }`).
- `.env.example` — добавить `AHREFS_API_KEY=`.

### 3.8 Ошибки (`src/shared/errors.ts`)
- Добавить `AHREFS_RATE_LIMIT`, `AHREFS_ERROR`, `AHREFS_NOT_CONFIGURED` (опц.) в `ResearchErrorCode`.

### 3.9 CLI (`src/cli/research.ts`)
- Env-driven (`AHREFS_API_KEY`); опционально флаг `--ahrefs-token` (необязательно, env предпочтительнее). Документировать в `printUsage`.

### 3.10 Snapshots/output (`src/runs/snapshots.ts`)
- `serp.json` уже содержит строки — добавить в них `registrableDomain` и `dr` (бесплатно через `SerpResult`).
- Опционально `domains.json` (уникальные домены + DR) для agent-readable вывода.
- `manifest.json.progress` дополнить `totalDomains`/`completedDomains`.

## 4. Acceptance (из плана + уточнения)

1. `registrableDomain` корректен для multi-part TLD, IP, невалидных значений.
2. Повторяющийся домен по набору ключевых слов → ровно один fresh Ahrefs lookup на TTL-окно (проверяется mock-тестом: 2 keyword с одним доменом → 1 вызов API).
3. `not_found`/`error` не ломают run; `dr=null` с корректным статусом.
4. `serp_rows` персистентно хранит `dr`/`registrable_domain`; `serp.json` содержит их.
5. Отсутствие `AHREFS_API_KEY` → run завершается, `dr=null`, без падения.
6. Токен отсутствует в `manifest.json`.
7. typecheck + тесты проходят; DR-фаза покрыта unit/integration тестами с mock fetch (реальные сетевые вызовы в CI не требуются).

## 5. Возможные конфликты с несмёрженными PR8/PR9/PR10

PR6 базируется отдельно от `main` (как договорились для PR5). Все конфликты при последующем мерже — **управляемые (механические)**, т.к. PR6 в основном добавляет НОВЫЕ модули и НОВЫЕ поля/блоки, не переписывая логику других PR.

| Область | Что меняет PR6 | Пересекается с | Характер |
|---|---|---|---|
| `src/google/serp.ts` (`SerpResult` +registrableDomain/dr) | новые поля | — (другие PR не трогали) | нет конфликта |
| `src/db/store.ts` (миграция v2→v3, serp_rows +dr/registrable_domain, loadSerpRows/commitKeyword) | схема + сериализация serp | PR9 менял store (keywords/StoredKeyword) — разные таблицы; но `SCHEMA_VERSION`/`MIGRATIONS` рядом | управляемый |
| `src/db/store.ts` (domain cache) | **не меняет** (использует готовый) | — | — |
| `src/runs/run.ts` (`RunManifest.progress` +totalDomains/+completedDomains) | новые поля манифеста | PR10 менял run.ts (`KeywordSource` union) — разные места | управляемый |
| `src/config/config.ts` (+ahrefs block, drThresholds) | новый блок | PR10 менял config (expansion) — разные блоки | управляемый |
| `src/shared/errors.ts` (+AHREFS_*) | новые коды | PR10 менял errors (`SURFER_RELATED_PARSE_ERROR`) — разные строки | управляемый |
| `src/runs/engine.ts` (DR-фаза, доменный прогресс) | новая фаза + импорты | PR10 менял engine (expansion блок) — разные места | управляемый |
| `src/runs/snapshots.ts` (+dr в serp.json, опц. domains.json, manifest domains) | новый вывод | PR8 менял snapshots (`source_rows`) — пересечение в `writeSnapshots` | управляемый |
| `src/cli/research.ts` (+ahrefs env/flag) | новый аргумент/док | PR10 менял research (`--expand`) — `parseArgs`/`printUsage` | управляемый |
| `src/cache/keys.ts` | использует `buildDomainCacheKey` (уже есть) | — | — |
| `src/ahrefs/`, `src/domains/` | **новые модули** | — | нет конфликта |

**Рекомендация по мержу**: накопление 4 независимых PR (8/9/10/6) увеличивает число точек слияния. Чтобы свести конфликты к минимуму, либо (а) смержить PR8/PR9/PR10 перед PR6 и базировать PR6 на обновлённом `main`, либо (б) принимать, что финальный мерж потребует механического объединения добавлений в `run.ts`/`store.ts`/`config.ts`/`errors.ts`/`snapshots.ts`/`research.ts` (каждый PR добавляет свои строки, не удаляя чужие).

## 6. Решения (зафиксированы)

1. **Точный Ahrefs endpoint** — РЕШЕНО: адаптер изолирует endpoint; конкретный URL/версию (v2 `apiv2.ahrefs.com` `from=domain_rating` или v3 Batch) фиксируем при реализации PR6. Обязательно: официальный free API, НЕ UI-скрапинг. Интерфейс `DomainRatingResult` неизменен.
2. **PSL-зависимость** — РЕШЕНО: **мини-эвристика без новой зависимости**. `registrableDomain` = последние 2 лейбла, кроме явного списка multi-part TLD (`co.uk`, `com.au`, `co.jp`, `co.nz`, `com.br`, …) → берём 3 лейбла. Соответствует AGENTS (no unnecessary deps). Покрывает ~99% SEO-доменов; при необходимости позже можно заменить на `psl`.
3. **Batch API** — опционален; для v1 одиночные вызовы с `minDelayMs` между ними (cache уже дедупит).
4. **DR-фаза per-keyword vs post-run** — РЕКОМЕНДУЕТСЯ per-keyword (проще, персистентный `domain_cache` даёт глобальный дедуп бесплатно). Post-run batch-pass — оптимизация, не обязательна для acceptance.

## 7. План тестирования

- `src/domains/normalize.test.ts` — registrable domain (multi-part TLD, IP→null, невалид→null, case).
- `src/ahrefs/client.test.ts` — mock `fetch`: ok/not_found/error/429 + retry/backoff; отсутствие ключа.
- `src/runs/engine.expansion.test.ts` аналог для DR: mock ahrefs, проверка «2 keyword → 1 API call на общий домен», cache hit не вызывает API.
- `src/db/store.test.ts` — миграция v2→v3, serp_rows хранит dr/registrable_domain (уже есть тесты domain cache — оставить).
- `src/google/serp.test.ts` — `registrableDomain` заполняется в `buildOrganicResults`.
- typecheck + `npm test` (153+ тестов).

## 8. Риски

- Сетевые вызовы Ahrefs в CI заблокированы (нет ключа/сети) → только mock-тесты; реальный прогон требует интерактивной среды (как Surfer/CAPTCHA).
- Утечка секрета в `manifest.json` — явно исключить токен из `configSnapshot`.
- Rate-limit триггер — обязателен `minDelayMs` между вызовами и обработка `429`.
