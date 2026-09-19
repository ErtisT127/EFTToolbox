param([int]$Port = 47831)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Push-Location $projectRoot
$serverProcess = $null
try {
    & pnpm.cmd install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
    if (-not (Test-Path 'data/upstream/catalog.json')) { throw 'Map cache missing; run pnpm toolbox data refresh first.' }
    & pnpm.cmd build
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed' }
    New-Item -ItemType Directory -Force build | Out-Null
    & go build -o build/EFTToolbox.exe ./backend/cmd/EFTToolbox
    if ($LASTEXITCODE -ne 0) { throw 'Backend build failed' }
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
                $serverProcess.Kill()
                $serverProcess.WaitForExit()
            }
        }
        $serverProcess.Dispose()
    }
    Pop-Location
}
