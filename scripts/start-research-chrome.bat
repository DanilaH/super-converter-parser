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

:: --- Check if research Chrome is already running (match by profile dir) ---
:: Uses PowerShell + CIM (not deprecated WMIC) to inspect command lines. If a
:: Chrome instance with this profile is already running, skip launching a new
:: one and reuse the existing window.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like \"*--user-data-dir=%RESEARCH_PROFILE_DIR%*\" } | Select-Object -First 1 ProcessId" > "%TEMP%\research_chrome_pid.txt" 2>nul
set /p RESEARCH_CHROME_PID=<"%TEMP%\research_chrome_pid.txt" 2>nul
del "%TEMP%\research_chrome_pid.txt" 2>nul

if defined RESEARCH_CHROME_PID (
    set "RESEARCH_CHROME_PID=%RESEARCH_CHROME_PID: =%"
)
if not "%RESEARCH_CHROME_PID%"=="" (
    echo [INFO] Research Chrome already running (PID: %RESEARCH_CHROME_PID%), reusing existing window.
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
echo   taskkill /FI "WINDOWTITLE eq Research Chrome" /F
echo.
