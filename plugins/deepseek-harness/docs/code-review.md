# Post-release code review

2026-09-12. Separate review of the published beta.1 implementation, followed by
targeted fixes for beta.2. An independent reviewer read runtime, callers, tests
and the public SDK; the implementation owner reproduced findings with synthetic
fixtures. This is not a security certification or a new native-client test.

## Findings and disposition

| Finding | Impact and fix |
| --- | --- |
| Credential-label redaction missed JSON key quotes and `API key` spelling | Conditional disclosure if child stderr contains a credential-bearing object. Five direct cases and a public-provider startup-error case failed before the fix and now pass, including escaped quotes. No real credential was accessed or observed leaking. |
| Probe timeout was reported as cleanup exit 143/SIGTERM | Reproduced with a hung fake `--version`. The deadline is now latched before child termination; event listeners are removed when the probe settles. The regression also checks child exit and absence of an ACP spawn. |
| Missing workspace was blamed on a missing executable | Node uses ENOENT for either. The error now names both executable and cwd and asks the user to check both paths, without claiming which is absent or adding filesystem preflights. |
| Stable/extended versions had misleading diagnostics | Extraction reports the complete stable/prerelease/build version; only the explicitly tested rc.1, rc.2, and alpha.2 releases are accepted. An untested `rc.2+custom` cannot pass by matching a tested prefix. |
| Redundant connection reference | Removed the write-only `ConnectionScope.connection` field. The cleanup closure already owns that connection. |
| Missing defensive-API coverage | Added invalid startup-timeout and unsupported-command tests. These do not add advertised capabilities. |

Relevant code: [connector and diagnostics](../server/dsh-compatibility.ts),
[provider ownership](../server/provider.ts), and the adjacent test files.

## Simplification decisions

- Keep explicit scope/resource ownership, pending-connect tracking and idempotent
  async disposal. Fewer lines would not justify weakening the tested shutdown
  ordering or per-session environment isolation.
- Do not add a shared cross-plugin runtime framework or replace the public ACP
  shim with a custom agent loop.
- Do not cache version probes without measured startup need and an invalidation
  design for executable/environment changes. The extra probe process is a known
  cost, not evidence of a correctness bug.
- Clarify that capability/catalog probes use daemon environment; per-session
  environment overrides apply to session runtimes.

## Verification and remaining boundaries

`npm run check` passes: typecheck, zero lint warnings/errors, **32 tests / 2 files**.
Before-fix failures were retained as local aggregate test logs, not private output
fixtures. Existing fake-peer tests still cover full output, permissions, cancel,
resume, cwd/env isolation, pending startup and host-close acknowledgement order.

The earlier official-API/installed-daemon evidence remains recorded separately in
[verification.md](verification.md). This review used fake child processes and
synthetic strings, not new paid inference or credentials. Diagnostic redaction
covers common labelled secrets; it cannot promise to recognize arbitrary
unlabelled secrets printed by trusted subprocesses. DSH's documented capability,
sandbox, discovery-session and native-client limitations remain in force.
