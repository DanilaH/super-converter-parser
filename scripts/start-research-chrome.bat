@echo off
setlocal

:: Research Chrome launcher for the parallel research profile.
:: Launches a dedicated Chrome instance (isolated profile) for the research runner,
:: leaving your main Chrome untouched.

:: --- Configuration (override via environment or edit here) ---
if "%RESEARCH_CHROME_PATH%"=="" set "RESEARCH_CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
if "%RESEARCH_PROFILE_DIR%"=="" set "RESEARCH_PROFILE_DIR=%USERPROFILE%\research-chrome-profile"
if "%RESEARCH_CDP_PORT%"=="" set "RESEARCH_CDP_PORT=9333"
if "%RESEARCH_CDP_TIMEOUT_SEC%"=="" set "RESEARCH_CDP_TIMEOUT_SEC=30"

:: --- Validate Chrome executable ---
if not exist "%RESEARCH_CHROME_PATH%" (
    echo [ERROR] Chrome not found: %RESEARCH_CHROME_PATH%
    echo Set RESEARCH_CHROME_PATH to your chrome.exe location.
    pause
    exit /b 1
)

:: --- Create clean research profile if it does not exist ---
if not exist "%RESEARCH_PROFILE_DIR%\Default" (
    echo Creating clean research profile at %RESEARCH_PROFILE_DIR%...
    mkdir "%RESEARCH_PROFILE_DIR%" 2>nul
    mkdir "%RESEARCH_PROFILE_DIR%\Default" 2>nul
    echo.
    echo [ACTION REQUIRED] First-time setup:
    echo   1. Sign in to Chrome in the Research Chrome window.
    echo   2. Install Keyword Surfer from the Chrome Web Store.
    echo   3. Verify it works on a Google SERP.
    echo.
)

:: --- Identify ONLY research Chrome by its profile directory ---
:: Do not kill Chrome instances by window title (fragile); match by the
:: --user-data-dir argument so the main browser is never touched.
set "RESEARCH_CHROME_PID="
for /f "tokens=*" %%a in ('wmic process where "name='chrome.exe' and commandline like '%%--user-data-dir=%RESEARCH_PROFILE_DIR:\=\\%%%%'" get ProcessId 2^>nul ^| findstr /r "[0-9]"') do (
    set "RESEARCH_CHROME_PID=%%a"
)

if defined RESEARCH_CHROME_PID (
    echo [INFO] Research Chrome already running (PID: %RESEARCH_CHROME_PID%).
    goto :wait_cdp
)

:: --- Launch research Chrome ---
echo Starting Research Chrome...
echo   Profile: %RESEARCH_PROFILE_DIR%
echo   CDP port: %RESEARCH_CDP_PORT%
echo.

start "Research Chrome" "%RESEARCH_CHROME_PATH%" ^
    --user-data-dir="%RESEARCH_PROFILE_DIR%" ^
    --profile-directory=Default ^
    --remote-debugging-port=%RESEARCH_CDP_PORT% ^
    --remote-allow-origins=* ^
    --no-first-run ^
    --no-default-browser-check

:: --- Wait for CDP with timeout ---
:wait_cdp
echo Waiting for CDP to respond (timeout: %RESEARCH_CDP_TIMEOUT_SEC%s)...
set /a "ELAPSED=0"

:cdp_poll
curl -s http://127.0.0.1:%RESEARCH_CDP_PORT%/json/version >nul 2>&1
if not errorlevel 1 goto :cdp_up

if %ELAPSED% geq %RESEARCH_CDP_TIMEOUT_SEC% (
    echo [ERROR] CDP did not respond within %RESEARCH_CDP_TIMEOUT_SEC% seconds.
    echo Chrome may have crashed or the profile is locked.
    echo Try: close all Chrome instances, delete "%RESEARCH_PROFILE_DIR%\Default\SingletonLock", retry.
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
set /a "ELAPSED+=1"
goto cdp_poll

:cdp_up
echo.
echo Research Chrome ready on http://127.0.0.1:%RESEARCH_CDP_PORT%
echo.
echo Next steps:
echo   1. Open a Google SERP in Research Chrome and verify Keyword Surfer shows volume/CPC.
echo   2. Run the research:
echo      set CDP_URL=http://127.0.0.1:%RESEARCH_CDP_PORT%
echo      npm run research -- --seeds input/seeds.csv
echo.
echo To stop Research Chrome: close its window, or:
echo   wmic process where "name='chrome.exe' and commandline like '%%--user-data-dir=%RESEARCH_PROFILE_DIR:\=\\%%%%'" delete
echo.
pause
