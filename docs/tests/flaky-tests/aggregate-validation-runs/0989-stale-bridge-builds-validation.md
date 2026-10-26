# Stale bridge builds (0056) validation: aggregate five-second timeouts

- **ID:** 0989
- **Status:** environmental
- **Date observed:** 2026-10-26
- **Change under test:** todo 0056 on `todo-0056-stale-bridge-builds-f8fc1693b936`,
  based on `93018933`: `dev:test` builds the bridges through Turbo and records
  them (`apps/desktop/scripts/dev/bridge-builds.ts`, `lifecycle.ts`), and the
  agent-testing Playwright configs gain a global setup. No firewall, bridge,
  environment-move or backend code changed.
- **Original command:** `mise run test:logged -- --name full-test-2 -- mise run test`
  (default reservations; other worktrees validating on the same host, load
  average 37 to 47 on 18 cores).
- **Aggregate result:** failed after 772.2 s. Every failure hit Bun's
  five-second deadline in a test the change does not reach:
  - `tests/unit/firewall-policy.test.ts`: five `container firewall policy`
    cases (5004 to 5020 ms), including `firewall uses stored domains and
    tolerates a repeated GitHub bootstrap range`
    ([0192](../environments-and-containers/0192-firewall-bootstrap-shell-timeout.md))
    and `policy 3 allowlist example.com:443/udp chooses blocked HTTPS probe
    example.com` ([0632](../environments-and-containers/0632-firewall-policy-probe-budget.md)).
  - `apps/backend/src/core/environment-move.test.ts`: `moves a worktree with
    nested submodules (same disk)`
    ([0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md)),
    `(copy)`, and `a failed submodule re-link restores the original checkout`
    ([0291](../environments-and-containers/0291-environment-move-submodule-aggregate-timeout.md)).
  - `bridges/acp-bridge/src/acp-http.test.ts`: `ACP bridge > reaps a session
    process when the creating HTTP client disconnects` (5669.62 ms;
    [0034](../agent-bridges/0034-acp-bridge-reaps-a-session-process-when-the-crea.md)).
- **Owner reruns:** each unchanged owner passed alone through
  `mise run test:logged` with `--parallel=1`: `firewall-owner` (30.6 s),
  `move-owner` (19.0 s, from `apps/backend` with the node setup preload) and
  `acp-http-owner` (5.1 s, from `bridges/acp-bridge`).
- **Earlier run of the same change:** the first full run passed all of these
  owners. It failed only on the register test for case 0887 (missing ID and
  status lines, fixed in the same change) and on the preview discovery
  `EADDRINUSE` recorded under
  [0942](0942-service-preview-rollout-0042-validation.md).
- **Evidence:** group logs in `orkestrator-test-run.cgh2DT/`, outer log in
  `orkestrator-test-run.tgPLw1/`, under the host temporary directory.

No assertion, timeout or skip was changed. Shared-host load is the likely
contributor, not an established cause.
