#Requires -Version 7.0
param(
    [string]$NuGetSource,
    [ValidateRange(0, 65535)][int]$Port = 5077
)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    & npm ls --depth=0 --silent *> $null
    if ($LASTEXITCODE -ne 0) {
        & npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    $restoreArguments = @('restore', 'Server\MemoryFlight.csproj', '--locked-mode', '--verbosity', 'quiet')
    if ($NuGetSource) { $restoreArguments += @('--source', $NuGetSource) }
    & dotnet @restoreArguments
    if ($LASTEXITCODE -ne 0) { throw 'Backend restore failed. Check the NuGet error above; use -NuGetSource to explicitly override the package feed.' }
    Set-Location (Join-Path $PSScriptRoot 'Server')
    & dotnet run --project MemoryFlight.csproj -c Release --no-restore --no-launch-profile -- "--MemoryFlight:Port=$Port"
    if ($LASTEXITCODE -ne 0) { throw 'Heapscape server failed.' }
} finally { Pop-Location }
