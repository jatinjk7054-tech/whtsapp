# UCS CRM automatic updater
# Polls GitHub for new code on the repo's default branch. When new commits
# exist, fast-forward merges (safe), reinstalls/rebuilds frontends, restarts the
# backend, and logs the result. Logs: database/logs/ui-update.log
#
# Safe-by-design:
#  - Only ever does a fast-forward merge (--ff-only). If local edits conflict
#    with incoming commits, the merge is ABORTED and nothing is force-applied,
#    so an update can never break the working local setup.
#  - .env files are gitignored and are never touched by the pull.

param(
    [string]$Repo = "C:\Users\Administrator\Desktop\UCS-CRM\UCS_CRM",
    [string]$LogFile = "C:\Users\Administrator\Desktop\UCS-CRM\UCS_CRM\database\logs\ui-update.log",
    [string]$NodeExe = "C:\Program Files\nodejs\node.exe",
    [string]$NpmCmd = "C:\Program Files\nodejs\npm.cmd",
    [string]$Branch = ""          # empty -> use current branch's upstream
)

$ErrorActionPreference = "Stop"
function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Write-Output $line
    Add-Content -Path $LogFile -Value $line
}

# Runs a native command without letting its stderr output trip $ErrorActionPreference.
# Returns $LASTEXITCODE from the command.
function Run-Native([scriptblock]$cmd) {
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $cmd 2>&1 | Out-Null
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldPref
    }
    return $code
}

# Ensure log dir exists
$logDir = Split-Path -Parent $LogFile
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

Set-Location $Repo

# ---------- 1) fetch ----------
Log "=== update check start ==="
try {
    Run-Native { git fetch origin }
    if ($LASTEXITCODE -ne 0) { Log "git fetch FAILED (exit $LASTEXITCODE) - network/credentials?"; exit 1 }
} catch {
    Log "git fetch exception: $($_.Exception.Message)"
    exit 1
}

# Determine current branch and its upstream
if (-not $Branch) {
    $Branch = (& git rev-parse --abbrev-ref HEAD).Trim()
    if ($Branch -eq "HEAD") { $Branch = "master" }
}
$upstream = (& git rev-parse --abbrev-ref --symbolic-full-name "$Branch@{u}" 2>$null).Trim()
if (-not $upstream) {
    # no upstream configured; default to origin/<branch>
    $upstream = "origin/$Branch"
}

# ---------- 2) are there new commits? ----------
$count = (& git rev-list --count "HEAD..$upstream" 2>$null).Trim()
Log "branch=$Branch upstream=$upstream new_commits=$count"
if ([int]$count -le 0) {
    Log "no new code; nothing to do"
    Log "=== update check end (no-op) ==="
    exit 0
}
Log "found $count new commit(s); deploying"

# ---------- 3) fast-forward merge (safe) ----------
Run-Native { git merge --ff-only $upstream }
if ($LASTEXITCODE -ne 0) {
    Log "MERGE CONFLICT / non-fast-forward. NOT applying. Manual merge required (likely backend/src/config/db.js or index.js touched locally)."
    Log "=== update check end (skipped - manual merge needed) ==="
    exit 1
}
Log "fast-forward merge succeeded -> HEAD now $(git rev-parse --short HEAD)"

# ---------- 4) npm install backend if package.json changed ----------
$backendChanged = (& git diff --name-only "HEAD@{1}" HEAD -- backend/package.json 2>$null)
if ($LASTEXITCODE -eq 0 -and $backendChanged) {
    Log "backend/package.json changed -> npm install"
    Push-Location "backend"
    Run-Native { & $NpmCmd install }
    if ($LASTEXITCODE -ne 0) { Log "backend npm install exit $LASTEXITCODE" }
    Pop-Location
} else {
    Log "backend/package.json unchanged; skipping backend npm install"
}

# ---------- 5) rebuild frontends that have node_modules ----------
$frontends = @("ucs crm", "database", "recruit-quizz")
foreach ($fe in $frontends) {
    $dir = Join-Path $Repo $fe
    if (-not (Test-Path (Join-Path $dir "package.json"))) { continue }
    $srcChanged = (& git diff --name-only "HEAD@{1}" HEAD -- "$fe" 2>$null)
    $ok = $LASTEXITCODE -eq 0
    if (-not $ok -or -not $srcChanged) {
        # treat as "changed" not detectable -> rebuild anyway if node_modules present
        $srcChanged = ""
    }
    if (-not (Test-Path (Join-Path $dir "node_modules"))) {
        Log "${fe}: no node_modules; skipping build (secondary panel)"
        continue
    }
    if ($srcChanged -or $true) {
        Log "building $fe ..."
        Push-Location $dir
        Run-Native { & $NpmCmd run build }
        if ($LASTEXITCODE -ne 0) { Log "$fe build exit $LASTEXITCODE" }
        Pop-Location
    }
}

# ---------- 6) restart backend (port 5000) ----------
Log "restarting backend on port 5000"
$conn = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}
$bLog = "C:\Users\ADMINI~1\AppData\Local\Temp\1\opencode\backend.log"
Start-Process -FilePath $NodeExe -ArgumentList "src/index.js" `
    -WorkingDirectory (Join-Path $Repo "backend") `
    -RedirectStandardOutput $bLog -RedirectStandardError "$bLog.err" `
    -WindowStyle Hidden
Start-Sleep -Seconds 6

# Verify backend up
try {
    $h = Invoke-RestMethod "http://192.168.1.60:5000/api/health" -TimeoutSec 10
    Log "backend healthy: commit=$($h.commit) db=$($h.db)"
} catch {
    Log "backend health check FAILED: $($_.Exception.Message)"
    exit 1
}

Log "=== update check end (deployed OK) ==="
exit 0
