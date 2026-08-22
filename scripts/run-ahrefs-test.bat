@echo off
setlocal

REM Run a small Ahrefs DR test (3 keywords). Requires AHREFS_API_KEY set separately.
REM Usage: set AHREFS_API_KEY=your_key && scripts\run-ahrefs-test.bat

if "%AHREFS_API_KEY%"=="" (
    echo ERROR: AHREFS_API_KEY not set.
    echo   set AHREFS_API_KEY=your_key_here
    echo   scripts\run-ahrefs-test.bat
    exit /b 1
)

echo Starting research Chrome (if not already running)...
tasklist /FI "WINDOWTITLE eq Research Chrome*" /FO CSV 2>nul | findstr /i "chrome.exe" >nul
if errorlevel 1 (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
      --user-data-dir=C:\chrome-research ^
      --profile-directory=Default ^
      --remote-debugging-port=9333 ^
      --remote-allow-origins=* ^
      --no-first-run ^
      --no-default-browser-check
    timeout /t 5 /nobreak >nul
)

echo Running 3-keyword Ahrefs test...
CDP_URL=http://127.0.0.1:9333 npm run research -- --seeds input/ahrefs-test-seeds.csv --require-ahrefs --force-refresh
echo.
echo If AHREFS_API_KEY is invalid/unusable, you'll see AHREFS_ERROR/AHREFS_RATE_LIMIT.
echo Check runs/<runId>/report.md for the Ahrefs summary.
