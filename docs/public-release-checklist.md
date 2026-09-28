# Public-release checklist

Heapscape is being prepared for possible public release under the approved [MIT License](../LICENSE). This checklist does not authorize a visibility change.

## Owner decisions before publication

- [x] **Choose and approve a license.** The owner approved MIT, copyright 2026 Konrad Kokosa. The repository includes the standard license; third-party license/notice review remains a separate release check.
- [ ] **Confirm naming.** The product is **Heapscape** and the repository is **kkokosa/heapspace**. Keeping this spelling is intentional for now; decide whether to keep it before publishing links broadly.
- [ ] **Approve public visibility explicitly.** Keep the repository private until the owner accepts the release scope and the remaining risks. Review the full Git history as well as the working tree before changing visibility.
- [ ] **Choose private vulnerability reporting.** Enable and verify GitHub private vulnerability reporting when available, or publish an approved private contact route. Update [SECURITY.md](../SECURITY.md) accordingly.

## Content and dependency review

- [ ] Review source, history, documentation, workflow logs, and future release artifacts for secrets, machine-specific paths, personal notes, and captured process data. Ignore rules are not a substitute for this review.
- [ ] Review public screenshots and videos for addresses, type names, previews, terminal paths, and background UI. Distribute fixture source and local instructions only, never dump/archive payloads: even synthetic process dumps may contain machine configuration, personal paths, and credentials.
- [ ] Review dependency licenses, notices, provenance, and known vulnerabilities, including npm packages, ClrMD, .NET, Orchard fixture dependencies, and pinned Actions. Decide whether to enable dependency alerts, update automation, and secret scanning where available.
- [ ] Perform a scoped security review of dump/DAC loading, local API boundaries, temporary-file handling, and native parsing. Current correctness checks are not a full security audit or evidence of sandboxing.

## Release expectations

- [ ] Confirm clean-checkout Windows builds and synthetic CI checks pass. Review immutable Action pins when updating workflows.
- [ ] Run fixture-dependent upload/browser/large-graph checks separately when making claims about them. Dumps and exported fixture JSON are not distributed, and these suites are not part of the minimal CI workflow.
- [ ] Document the tested Windows x64/runtime/browser combinations and retain the trusted-dumps-only, local-only, matching-DAC, memory-use, ten-minute-worker, and incomplete-evidence limitations.
- [ ] Decide initial release/version, support and vulnerability-response expectations, and whether branch protection/review requirements should be enabled. No hosted service, binary distribution, cross-platform support, or response-time guarantee is implied.

## Baseline in the repository

The repository contains concise setup and reference documentation, [contribution guidance](../CONTRIBUTING.md), a security policy, generated-data ignore rules, and Windows CI using read-only permissions and official Actions pinned to immutable commits. CI restores locked JavaScript/backend dependencies, builds the app, and runs synthetic Node/.NET checks without uploading artifacts or generating dump fixtures.
