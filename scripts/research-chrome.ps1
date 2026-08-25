param(
  [ValidateSet("setup", "start")]
  [string]$Mode = "start",
  [string]$ProfileRoot = "C:\\tmp\\research-profile",
  [int]$Port = 9333
)

$ErrorActionPreference = "Stop"
$sourceProfile = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Default"
$targetProfile = Join-Path $ProfileRoot "Default"
$chromeCandidates = @(
  (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
  (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
)
$chrome = $chromeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $chrome) {
  throw "Google Chrome was not found in Program Files or LocalAppData."
}

if ($Mode -eq "setup") {
  if (-not (Test-Path $sourceProfile)) {
    throw "Chrome Default profile was not found: $sourceProfile"
  }
  New-Item -ItemType Directory -Force -Path $ProfileRoot | Out-Null
  & robocopy $sourceProfile $targetProfile /E /XD Cache "Code Cache" "Service Worker" /XF *.log | Out-Null
  if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed with exit code $LASTEXITCODE"
  }
  Write-Host "Research Chrome profile prepared: $ProfileRoot"
  Write-Host "Run npm run chrome:start, then verify Keyword Surfer once in chrome://extensions."
  exit 0
}

if (-not (Test-Path $targetProfile)) {
  throw "Research profile is missing. Run npm run chrome:setup first."
}

Start-Process -FilePath $chrome -ArgumentList @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$ProfileRoot",
  "--profile-directory=Default",
  "--remote-allow-origins=*"
)

$endpoint = "http://127.0.0.1:$Port/json/version"
for ($attempt = 1; $attempt -le 20; $attempt += 1) {
  try {
    Invoke-RestMethod -Uri $endpoint -TimeoutSec 1 | Out-Null
    Write-Host "Research Chrome is ready: http://127.0.0.1:$Port"
    exit 0
  } catch {
    Start-Sleep -Milliseconds 500
  }
}

throw "Chrome started, but CDP did not become available at http://127.0.0.1:$Port"
