@echo off
setlocal

REM Kill any existing research Chrome
tasklist /FI "WINDOWTITLE eq Research Chrome*" /FO CSV 2>nul | findstr /i "chrome.exe" >nul
if not errorlevel 1 (
    echo Killing existing research Chrome...
    taskkill /F /IM chrome.exe /FI "WINDOWTITLE eq Research Chrome*" 2>nul
    timeout /t 2 /nobreak >nul
)

echo Starting Research Chrome (parallel profile)...
start "Research Chrome" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --user-data-dir=C:\chrome-research ^
  --profile-directory=Default ^
  --remote-debugging-port=9333 ^
  --remote-allow-origins=* ^
  --no-first-run ^
  --no-default-browser-check

echo Waiting for CDP...
:wait_cdp
curl -s http://127.0.0.1:9333/json/version >nul 2>&1
if errorlevel 1 (
    timeout /t 1 /nobreak >nul
    goto wait_cdp
)

echo Research Chrome ready on http://127.0.0.1:9333
echo.
echo Open a Google SERP in Research Chrome and verify Keyword Surfer is active.
echo Then run:
echo   CDP_URL=http://127.0.0.1:9333 npm run research -- --seeds input/seeds.csv --require-ahrefs
echo.
echo Or for optional mode (no Ahrefs):
echo   CDP_URL=http://127.0.0.1:9333 npm run research -- --seeds input/seeds.csv
