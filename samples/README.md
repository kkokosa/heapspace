# Console sample: source only

The sample application is already in [Fixtures/ConsoleApp](../Fixtures/ConsoleApp), with its shared workload in [Fixtures/Graph.cs](../Fixtures/Graph.cs). No duplicate app, compiled binary, dump, or archive is distributed here.

It creates synthetic objects across generations, shared/cyclic references, LOH and POH allocations, strong/pinned/weak handles, a conditional weak table, stack/static/thread-static roots, finalization examples, and a native allocation.

**Synthetic workload does not mean sanitized memory.** A dump can include inherited environment values, machine/user paths, runtime data, and other private information. Create dumps only on a machine and process you trust; keep them local. Never commit, upload, or attach dumps or their archives, including dumps from this sample.

## Build and run

Use Windows x64, PowerShell 7, and the .NET 10 SDK. From the repository root, in a first terminal:

```powershell
dotnet build .\Fixtures\ConsoleApp\ConsoleApp.csproj -c Release
dotnet .\Fixtures\ConsoleApp\bin\Release\net10.0\ConsoleApp.dll
```

Wait for `MEMORYFLIGHT_READY`. Leave this process running while collecting the dump; it waits intentionally so the synthetic roots remain alive.

## Collect a local dump

In a second terminal at the repository root:

```powershell
# Install only if dotnet-dump is not already available.
dotnet tool install --global dotnet-dump
dotnet-dump ps
```

Find the process whose command line ends in `ConsoleApp.dll`. Do not choose Heapscape itself or another running application. Supply that process ID when prompted:

```powershell
[int]$fixturePid = Read-Host 'PID of the ready ConsoleApp.dll process'
New-Item -ItemType Directory -Force .\artifacts\dumps | Out-Null
$dump = Join-Path $PWD 'artifacts\dumps\console-local.dmp'
if (Test-Path -LiteralPath $dump) { throw 'Choose a new output filename; do not overwrite an existing dump.' }
dotnet-dump collect --process-id $fixturePid --type Full --output $dump
```

`artifacts` and dump/archive extensions are ignored by Git. These rules are a guardrail, not sanitization; do not bypass them with `git add -f`. Stop the sample with Ctrl+C in its first terminal after collection.

## Open in Heapscape

```powershell
pwsh -File .\Start.ps1 -Port 5087
```

Open http://127.0.0.1:5087, select **Open a memory dump**, and choose the local `artifacts\dumps\console-local.dmp`. String previews are optional and may expose private content; leaving them disabled does not make the dump safe to share.

Matching local runtime/DAC and architecture are required. Full captures can be large; size depends on the runtime and host. No downloadable sample size or sanitization guarantee is claimed. Remove the processed copy from the viewer and delete your local dump when no longer needed; deletion is not secure erasure.
