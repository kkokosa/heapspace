#Requires -Version 7.0
param(
    [ValidateSet('All', 'Console', 'AspNet', 'Orchard')][string]$Scenario = 'All',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'artifacts\dumps'),
    [ValidateRange(10, 120)][int]$LoadSeconds = 20,
    [string]$NuGetSource
)
$ErrorActionPreference = 'Stop'
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
if (-not (Get-Command dotnet-dump -ErrorAction SilentlyContinue)) {
    throw 'dotnet-dump is required. Install with: dotnet tool install --global dotnet-dump'
}
$children = [Collections.Generic.List[object]]::new()

function Build-Fixture([string]$Name) {
    $project = Join-Path $PSScriptRoot "Fixtures\$Name\$Name.csproj"
    $restoreArguments = @('restore', $project, '--verbosity', 'quiet')
    if (Test-Path (Join-Path (Split-Path $project) 'packages.lock.json')) { $restoreArguments += '--locked-mode' }
    if ($NuGetSource) { $restoreArguments += @('--source', $NuGetSource) }
    & dotnet @restoreArguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Restore failed: $Name. Check the NuGet error above; use -NuGetSource to explicitly override the package feed." }
    & dotnet build $project -c Release --no-restore --verbosity quiet | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $Name" }
    return Join-Path $PSScriptRoot "Fixtures\$Name\bin\Release\net10.0\$Name.dll"
}
function Start-Fixture([string]$Name, [string]$Dll, [string[]]$Arguments = @(), [string]$WorkingDirectory = '') {
    $start = [Diagnostics.ProcessStartInfo]::new('dotnet')
    $start.UseShellExecute = $false
    $start.WorkingDirectory = if ($WorkingDirectory) { $WorkingDirectory } else { Split-Path $Dll }
    $start.ArgumentList.Add($Dll)
    foreach ($arg in $Arguments) { $start.ArgumentList.Add($arg) }
    $start.Environment['DOTNET_GCHeapCount'] = '4'
    $start.Environment['DOTNET_EnableDiagnostics'] = '1'
    $start.Environment['ASPNETCORE_ENVIRONMENT'] = 'Development'
    $readyPath = Join-Path $OutputDirectory "$Name.$([Guid]::NewGuid().ToString('N')).ready"
    $start.Environment['HEAPSCAPE_READY_FILE'] = $readyPath
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    $child = @{
        Process = $process
        Out = $process.StandardOutput.ReadToEndAsync()
        Err = $process.StandardError.ReadToEndAsync()
        Name = $Name
        ReadyPath = $readyPath
    }
    $children.Add($child)
    return $child
}
function Wait-Http([string]$Url, $Child) {
    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Child.Process.HasExited) { throw "$($Child.Name) exited: $($Child.Err.Result) $($Child.Out.Result)" }
        try {
            $response = Invoke-WebRequest $Url -TimeoutSec 10
            if ($response.StatusCode -eq 200) { return $response.Content }
        } catch [System.Net.Http.HttpRequestException] { Start-Sleep -Milliseconds 500 }
        catch [System.Threading.Tasks.TaskCanceledException] { Start-Sleep -Milliseconds 500 }
    }
    throw "No successful response from $Url. Fixture stdout/stderr are saved in $OutputDirectory."
}
function Stop-Child($Child) {
    if (-not $Child.Process.HasExited) { $Child.Process.Kill($true); $Child.Process.WaitForExit() }
    [IO.File]::WriteAllText((Join-Path $OutputDirectory "$($Child.Name).stdout.log"), $Child.Out.Result)
    [IO.File]::WriteAllText((Join-Path $OutputDirectory "$($Child.Name).stderr.log"), $Child.Err.Result)
}
function Capture([string]$Name, $Child) {
    $dump = Join-Path $OutputDirectory "$Name.dmp"
    if (Test-Path $dump) { throw "$dump already exists. Choose another output directory or explicitly remove the old fixture." }
    & dotnet-dump collect --process-id $Child.Process.Id --type Full --output $dump
    if ($LASTEXITCODE -ne 0) { throw "Dump collection failed: $Name" }
    Get-Item $dump | Select-Object Name, Length
}
Push-Location $PSScriptRoot
try {
    $loadDll = Build-Fixture 'LoadClient'
    if ($Scenario -in @('All', 'Console')) {
        $dll = Build-Fixture 'ConsoleApp'
        $child = Start-Fixture 'console' $dll
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while (-not (Test-Path $child.ReadyPath)) {
            if ($child.Process.HasExited) { throw "Console fixture exited: $($child.Err.Result)" }
            if ([DateTime]::UtcNow -gt $deadline) { throw 'Console fixture did not signal readiness.' }
            Start-Sleep -Milliseconds 200
        }
        Capture 'console' $child
        Stop-Child $child
    }
    foreach ($web in @(
        @{ Scenario = 'AspNet'; Project = 'AspNetApp'; Name = 'aspnet'; Port = 5081; Path = '/work' },
        @{ Scenario = 'Orchard'; Project = 'OrchardApp'; Name = 'orchard'; Port = 5082; Path = '/' }
    )) {
        if ($Scenario -notin @('All', $web.Scenario)) { continue }
        $dll = Build-Fixture $web.Project
        $url = "http://127.0.0.1:$($web.Port)"
        $child = Start-Fixture $web.Name $dll @('--urls', $url) (Join-Path $PSScriptRoot "Fixtures\$($web.Project)")
        $content = Wait-Http "$url$($web.Path)" $child
        if ($web.Scenario -eq 'Orchard' -and ($content -match 'name="AdminPassword"' -or $content -notmatch 'Heapscape Orchard fixture')) {
            throw 'Orchard did not finish setup; refusing to call a setup-page dump a CMS load test.'
        }
        $resultPath = Join-Path $OutputDirectory "$($web.Name)-load.json"
        $load = Start-Fixture "$($web.Name)-load" $loadDll @("$url$($web.Path)", "$LoadSeconds", '12', $resultPath)
        Start-Sleep -Seconds 5
        if ($load.Process.HasExited) { throw "Load generator stopped before capture: $($load.Err.Result)" }
        Capture $web.Name $child
        $load.Process.WaitForExit()
        Stop-Child $load
        if ($load.Process.ExitCode -ne 0) { throw "Load failed. Inspect $resultPath" }
        Stop-Child $child
        Get-Content $resultPath
    }
} finally {
    foreach ($child in $children) {
        Stop-Child $child
        if (Test-Path $child.ReadyPath) { Remove-Item -LiteralPath $child.ReadyPath }
        $child.Process.Dispose()
    }
    Pop-Location
}
