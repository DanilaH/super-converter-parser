@echo off
setlocal enabledelayedexpansion

:: Research Chrome launcher for the parallel research profile.
:: Launches a dedicated Chrome instance (isolated profile) for the research runner,
:: leaving your main Chrome untouched.

:: --- Configuration (override via environment or edit here) ---
if "%RESEARCH_CHROME_PATH%"=="" set "RESEARCH_CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
if "%RESEARCH_PROFILE_DIR%"=="" set "RESEARCH_PROFILE_DIR=C:\chrome-research"
if "%RESEARCH_CDP_PORT%"=="" set "RESEARCH_CDP_PORT=9333"
if "%RESEARCH_CDP_TIMEOUT_SEC%"=="" set "RESEARCH_CDP_TIMEOUT_SEC=30"
if "%RESEARCH_PROFILE_NAME%"=="" set "RESEARCH_PROFILE_NAME=Default"

:: --- Validate profile exists ---
if not exist "%RESEARCH_PROFILE_DIR%\%RESEARCH_PROFILE_NAME%" (
    echo [ERROR] Research profile not found: %RESEARCH_PROFILE_DIR%\%RESEARCH_PROFILE_NAME%
    echo Create it first:
    echo   robocopy "C:\Users\%USERNAME%\AppData\Local\Google\Chrome\User Data\Default" "%RESEARCH_PROFILE_DIR%\%RESEARCH_PROFILE_NAME%" /E /COPY:DAT /R:1 /W:1
    echo Then launch it once manually to initialize, install Keyword Surfer, and sign in.
    pause
    exit /b 1
)

:: --- Validate Chrome executable ---
if not exist "%RESEARCH_CHROME_PATH%" (
    echo [ERROR] Chrome not found: %RESEARCH_CHROME_PATH%
    set /p "RESEARCH_CHROME_PATH=Enter full path to chrome.exe: "
    if not exist "!RESEARCH_CHROME_PATH!" (
        echo [ERROR] Still not found. Aborting.
        pause
        exit /b 1
    )
)

:: --- Kill any existing research Chrome on this port ---
echo Checking for existing research Chrome on port %RESEARCH_CDP_PORT%...
for /f "tokens=*" %%a in ('curl -s http://127.0.0.1:%RESEARCH_CDP_PORT%/json/version 2^>nul') do (
    echo [WARN] CDP already responding on port %RESEARCH_CDP_PORT%.
    set /p "KILL_EXISTING=Kill existing Chrome instances using this port? [y/N]: "
    if /i "!KILL_EXISTING!"=="y" (
        taskkill /F /IM chrome.exe /FI "WINDOWTITLE eq Research Chrome*" 2>nul
        timeout /t 3 /nobreak >nul
    ) else (
        echo Aborting.
        pause
        exit /b 1
    )
)

:: --- Launch research Chrome ---
echo.
echo Starting Research Chrome...
echo   Profile: %RESEARCH_PROFILE_DIR%\%RESEARCH_PROFILE_NAME%
echo   CDP port: %RESEARCH_CDP_PORT%
echo.

start "Research Chrome" "%RESEARCH_CHROME_PATH%" ^
    --user-data-dir="%RESEARCH_PROFILE_DIR%" ^
    --profile-directory="%RESEARCH_PROFILE_NAME%" ^
    --remote-debugging-port=%RESEARCH_CDP_PORT% ^
    --remote-allow-origins=* ^
    --no-first-run ^
    --no-default-browser-check

:: --- Wait for CDP with timeout ---
echo Waiting for CDP (timeout: %RESEARCH_CDP_TIMEOUT_SEC%s)...
set /a "ELAPSED=0"
:wait_cdp
curl -s http://127.0.0.1:%RESEARCH_CDP_PORT%/json/version >nul 2>&1
if errorlevel 1 (
    if !GEAPSED! geq %RESEARCH_CDP_TIMEOUT_SEC% (
        echo [ERROR] CDP did not respond within %RESEARCH_CDP_TIMEOUT_SEC% seconds.
        echo Chrome may have crashed or the profile is locked.
        echo Try: close all Chrome instances, delete "%RESEARCH_PROFILE_DIR%\%RESEARCH_PROFILE_NAME%\SingletonLock", retry.
        pause
        exit /b 1
    )
    timeout /t 1 /nobreak >nul
    set /a "ELAPSED+=1"
    goto wait_cdp
)

echo.
echo Research Chrome ready on http://127.0.0.1:%RESEARCH_CDP_PORT%
echo.
echo Next steps:
echo   1. Open a Google SERP in Research Chrome and verify Keyword Surfer shows volume/CPC.
echo   2. Run the research:
echo      CDP_URL=http://127.0.0.1:%RESEARCH_CDP_PORT% npm run research -- --seeds input/seeds.csv
echo.
echo To stop Research Chrome: close its window or run: taskkill /F /IM chrome.exe /FI "WINDOWTITLE eq Research Chrome*"
echo.
pause
