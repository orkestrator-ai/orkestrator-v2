# Agent accounts and sign-in (0003) validation

- **ID:** 0740
- **Status:** open
- **Date observed:** 2026-10-24, node mbp3
- **Scope:** todo 0003 branch (`todo-0003-accounts-sign-in-cf5acbb74387`) after merging `origin/main` at `71227437`.

## Non-iOS repository suite

`ORKESTRATOR_TEST_AREA_BASE=$(git merge-base HEAD origin/main) mise run test:logged -- --name full-suite -- mise run test`
exited 1 after 632.0 s. Bridges and the Codex protocol lockfile group passed;
web 9212 passed, 10 skipped, 0 failed; root and agent-support 3370 passed and
14 failed; backend 10363 passed, 115 skipped and 14 failed.

| Owner | Failure | Complete owner rerun |
| --- | --- | --- |
| `tests/unit/test-diagnostic-bounds.test.ts` | `never passes a DOM-producing query result directly to toBeNull` named two test files this branch changed. | A real defect in the branch, not a flake: both files now compare `=== null`. The owner then passed (16 passed). |
| `tests/unit/firewall-policy.test.ts` | Thirteen `container firewall policy` cases hit Bun's five-second budget (~5,003 ms each). | Unchanged owner passed alone (24 passed, 0 failed). Registered as [0632](../environments-and-containers/0632-firewall-policy-probe-budget.md) and [0192](../environments-and-containers/0192-firewall-bootstrap-shell-timeout.md). |
| `apps/backend/src/core/conformance-execution-policy.test.ts` | Fourteen `execution policy conformance: opencode` cases expected OpenCode `1.19.0`; the installed CLI on mbp3 reports `1.19.4`. | Reproduces alone (56 passed, 14 failed): an environmental version mismatch on this host, already seen in [0512](../design-canvas-and-artifacts/0512-mermaid-watchdog-elapsed-under-load.md) and [0310](../native-agents-and-transcripts/0310-codex-subagent-cards-projection-wait-timeout.md). The branch does not touch OpenCode or the conformance suite. |

Owner rerun commands, from the repository root:

```sh
bun test tests/unit/test-diagnostic-bounds.test.ts
bun test tests/unit/firewall-policy.test.ts
(cd apps/backend && bun test --preload ../../tests/setup-node.ts src/core/conformance-execution-policy.test.ts)
```

Artifacts below the host temporary directory:
`orkestrator-test-run.WDlOx0/root-and-agent-support-tests.log.gz` and
`orkestrator-test-run.WDlOx0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

An earlier standalone Codex bridge run on this branch hit
[0093](../agent-bridges/0093-runtime-environment-refresh-sources-configured-r.md);
its unchanged owner passed alone.
