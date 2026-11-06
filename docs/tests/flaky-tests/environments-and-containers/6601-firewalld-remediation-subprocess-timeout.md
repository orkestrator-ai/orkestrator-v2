# Firewalld remediation subprocess timeout

- **ID:** 6601
- **Status:** open
- **Observed:** 2026-11-06, macOS arm64, Bun 1.4.4
- **File:** `apps/backend/src/core/container-host-reachability.test.ts`
- **Test:** `remediation > firewalld, 2 source(s): failure at source 2 stops later rules and reload`

## Failure

The combined owner run used:

```sh
mise run test:logged -- --name peer-owner-tests -- bun test --cwd apps/backend ./src/core/agent-tools.test.ts ./src/core/agent-tools-peer-filter.test.ts ./src/core/agent-tools-peer-gate.test.ts ./src/core/container-host-reachability.test.ts ./tests/container-network.test.ts ./tests/recovery-copies.test.ts --parallel=2 --only-failures
```

It reported 184 pass, 1 fail across six files in 32.94 s. The test timed out
at 5000 ms; its shell subprocess returned SIGTERM after 5004.98 ms at
`executeRemediation`, line 169. The runner retained evidence at
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.UDSEP3`.

## Isolated rerun

```sh
mise run test:logged -- --name reachability-isolated -- bun test --cwd apps/backend ./src/core/container-host-reachability.test.ts --parallel=1 --only-failures
```

Passed with exit 0 in 4.8 s. No remediation implementation or existing test
assertions changed between the failure and this rerun. The peer-gate change
adds only a separate network-notification test to this file.

## Investigation

The failure is in the existing bounded synchronous shell fixture, before its
rule assertions. Subprocess scheduling under concurrent work is a possible
cause, but no process trace establishes that cause. Keep the test and its
assertions unchanged; this entry records the failure and isolated pass.
