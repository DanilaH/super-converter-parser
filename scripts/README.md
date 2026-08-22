# Research Chrome Setup

The research runner connects to a running Chrome instance over CDP. To keep your
main browser untouched, launch a **dedicated research Chrome** with an isolated
profile.

## Quick start

```cmd
scripts\start-research-chrome.bat
```

The script:

- Creates a clean profile at `%USERPROFILE%\research-chrome-profile` (once).
- Launches Chrome with `--user-data-dir` pointing only at that profile.
- Waits for CDP on `http://127.0.0.1:9333` (override with `RESEARCH_CDP_PORT`).
- Identifies the research Chrome **by its profile path**, never by window title,
  so your main browser is never killed.

## First-time setup

1. Run `scripts\start-research-chrome.bat`.
2. In the Research Chrome window, sign in to Google.
3. Install **Keyword Surfer** from the Chrome Web Store.
4. Open any Google SERP and verify Surfer shows volume/CPC.

## Run a research

```cmd
set CDP_URL=http://127.0.0.1:9333
npm run research -- --seeds input/seeds.csv
```

With Ahrefs DR:

```cmd
set AHREFS_API_KEY=your_key
set CDP_URL=http://127.0.0.1:9333
npm run research -- --seeds input/seeds.csv --require-ahrefs
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `RESEARCH_CHROME_PATH` | `C:\Program Files\Google\Chrome\Application\chrome.exe` | Chrome executable |
| `RESEARCH_PROFILE_DIR` | `%USERPROFILE%\research-chrome-profile` | Isolated profile location |
| `RESEARCH_CDP_PORT` | `9333` | DevTools port |
| `RESEARCH_CDP_TIMEOUT_SEC` | `30` | CDP readiness timeout |

## Stopping

Close the Research Chrome window, or:

```cmd
wmic process where "name='chrome.exe' and commandline like '%%--user-data-dir=%USERPROFILE%\research-chrome-profile%%'" delete
```
