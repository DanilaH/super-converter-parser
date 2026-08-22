@echo off
setlocal

:: Quick Ahrefs DR test (3 keywords). Requires AHREFS_API_KEY in the environment.
:: Usage: set AHREFS_API_KEY=your_key && scripts\run-ahrefs-test.bat

if "%AHREFS_API_KEY%"=="" (
    echo [ERROR] AHREFS_API_KEY not set.
    echo   set AHREFS_API_KEY=your_key
    echo   scripts\run-ahrefs-test.bat
    pause
    exit /b 1
)

:: Reuse the dedicated research Chrome launcher.
call "%~dp0start-research-chrome.bat"
if errorlevel 1 exit /b 1

echo.
echo Running 3-keyword Ahrefs test...
echo.

set CDP_URL=http://127.0.0.1:9333
npm run research -- --seeds input/ahrefs-test-seeds.csv --require-ahrefs --force-refresh

echo.
echo If AHREFS_API_KEY is invalid you will see AHREFS_ERROR / AHREFS_RATE_LIMIT.
echo Check runs/<runId>/report.md for the Ahrefs summary.
pause
