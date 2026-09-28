# Contributing to Heapscape

See the [README](README.md) for Windows x64, .NET 10, Node.js 22.12+ on a supported release, PowerShell 7, and browser requirements. CI uses Node.js 24 and a stable .NET 10 SDK. Project source is licensed under [MIT](LICENSE); third-party dependencies retain their own licenses.

## Setup and checks

Run from the repository root:

```powershell
npm ci
npm test
npm run build
dotnet restore tests\MemoryFlight.Checks.csproj --locked-mode
dotnet build Server\MemoryFlight.csproj -c Release --no-restore
dotnet run --project tests\MemoryFlight.Checks.csproj -c Release --no-restore
pwsh -File .\Start.ps1 -Port 5087
```

Open http://127.0.0.1:5087 and stop with Ctrl+C. Use `-Port 0` for an unused port printed at startup. Keep a development instance separate from any viewer holding useful uploads.

The Windows CI workflow runs the Node tests, frontend/backend builds, and synthetic .NET checks. It does not generate dumps or run fixture-dependent tests. With installed Microsoft Edge, the fixture-free GPU check is:

```powershell
npm run test:browser -- spatial.spec.js --grep "transparent boxes"
```

See the [technical reference](docs/reference.md) for local fixture generation and full browser-test prerequisites. Do not report those suites as passing unless you generated their inputs and ran them.

## Changes and reports

Keep changes focused, preserve exact addresses and uncertainty/coverage semantics, and add regression tests for behavior changes. Retain internal `MemoryFlight` identifiers unless a change explicitly covers their consumers. Update relevant documentation and lockfiles; explain dependency upgrades rather than silently changing locked versions.

For bugs, include the commit, tool/runtime versions, reproduction steps, expected behavior, and a minimal synthetic reproducer. Review logs and screenshots before sharing.

**Never commit or attach memory dumps, dump archives, exported process graphs, credentials, personal data, or production logs.** Disabling string previews does not sanitize a dump. Generated fixture dumps can also contain environment data and synthetic credentials; provide source code that reproduces the issue, not captured memory. See the [source-only sample](samples/README.md) for local capture instructions. Git ignore rules do not make data safe to publish. Do not force-add ignored artifacts.

Report suspected vulnerabilities using the private procedure in [SECURITY.md](SECURITY.md), not a public issue or pull request.
