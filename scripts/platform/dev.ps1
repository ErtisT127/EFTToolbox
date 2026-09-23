param(
    [int]$Port = 47831,
    [switch]$Rebuild
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Push-Location $projectRoot
$env:GOROOT = $null
$serverProcess = $null
$forceRebuild = $Rebuild -or ($args -contains '--rebuild')
try {
    & pnpm.cmd install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
    if (-not (Test-Path 'data/upstream/catalog.json')) { throw 'Map cache missing; run pnpm toolbox data refresh first.' }
    & pnpm.cmd toolbox data fonts --check
    if ($LASTEXITCODE -ne 0) { throw 'Display resources missing or changed; run pnpm toolbox data fonts.' }
    $env:EFT_TOOLBOX_DASHBOARD_DEV = '1'
    $dashboardCacheValid = $false
    if (-not $forceRebuild) {
        & node scripts/cli.mjs cache check dashboard
        $dashboardCacheValid = $LASTEXITCODE -eq 0
    }
    if ($dashboardCacheValid) {
        Write-Host 'Dashboard unchanged; using cached build.'
    } else {
        & pnpm.cmd build
        if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed' }
        & node scripts/cli.mjs cache save dashboard
        if ($LASTEXITCODE -ne 0) { throw 'Dashboard cache save failed' }
    }
    New-Item -ItemType Directory -Force build | Out-Null
    $backendCacheValid = $false
    if (-not $forceRebuild) {
        & node scripts/cli.mjs cache check backend
        $backendCacheValid = $LASTEXITCODE -eq 0
    }
    if ($backendCacheValid) {
        Write-Host 'Backend unchanged; using cached executable.'
    } else {
        & go build -o build/EFTToolbox.exe ./backend/cmd/EFTToolbox
        if ($LASTEXITCODE -ne 0) { throw 'Backend build failed' }
        & node scripts/cli.mjs cache save backend
        if ($LASTEXITCODE -ne 0) { throw 'Backend cache save failed' }
    }
    & dotnet publish overlay/Overlay.csproj -c Release -o build/overlay --no-self-contained
    if ($LASTEXITCODE -ne 0) { throw 'Overlay build failed' }
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = Join-Path $projectRoot 'build/EFTToolbox.exe'
    $startInfo.Arguments = "-port $Port -dev-stdin -data `"$(Join-Path $projectRoot 'data')`""
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $serverProcess = [System.Diagnostics.Process]::Start($startInfo)
    while (-not $serverProcess.WaitForExit(200)) { }
    if ($serverProcess.ExitCode -ne 0) { throw 'Backend exited with an error' }
} finally {
    if ($null -ne $serverProcess) {
        if (-not $serverProcess.HasExited) {
            $serverProcess.StandardInput.Close()
            if (-not $serverProcess.WaitForExit(6000)) {
                $serverProcess.Kill($true)
                $serverProcess.WaitForExit()
            }
        }
        $serverProcess.Dispose()
    }
    Pop-Location
}
