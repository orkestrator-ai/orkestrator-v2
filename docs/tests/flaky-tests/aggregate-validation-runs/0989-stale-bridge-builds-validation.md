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

## Review-hardening validation, 2026-10-26

`mise run test:logged -- --name bridge-review-tests -- mise run test` repeated
the unchanged firewall owner's five-second deadlines. The root group used one
worker and finished in 255.3 s (3,467 passed, six failed); four failures were:

- `policy 2 narrows host access to named ports and records what it applied`
  (5,004.10 ms).
- `policy 3 allowlist  EXAMPLE.COM:443/tcp  chooses blocked HTTPS probe example.net`
  (5,017.54 ms).
- `policy 3 allowlist example.com:80 chooses blocked HTTPS probe example.com`
  (5,009.87 ms).
- `the root entrypoint runs the firewall itself and records the outcome per mode`
  (5,005.18 ms).

The other two root failures were new test ownership declarations, corrected in
the implementation; the focused ownership and runner tests then passed.

The complete unchanged owner also failed under
`mise run test:logged -- --name firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures`:
29 passed, five timed out, 192 assertions, 65.1 s. Its failures were policy 2,
policy 3 address/protocol/port tuples, both `example.com:443/tcp` variants, and
the root entrypoint, all at 5,003.95–5,007.32 ms. This observation is not newly
classified as flaky. Host load averages measured shortly after that run were
40.61, 50.15 and 55.95 on 18 cores; contention remains a hypothesis.

Evidence is in `orkestrator-test-run.r2VUEh/` (aggregate groups),
`orkestrator-test-run.Ri7lB9/` (outer log), and
`orkestrator-test-run.qOOXrw/` (isolated owner) under the host temporary directory.

The corrected-tree rerun,
`mise run test:logged -- --name bridge-review-final-tests -- mise run test`,
ran 3,483 root/agent-support tests in 333.3 s (3,471 passed, 12 failed). All
12 failures were in the unchanged firewall owner, with no ownership or bridge
freshness failures. Its exact failing cases and durations were:

| Test under `container firewall policy` | Duration (ms) |
| --- | ---: |
| `policy 2 narrows host access to named ports and records what it applied` | 5,005.51 |
| `policy 3 allows address, protocol and port tuples` | 5,006.71 |
| `policy 2 allowlist example.org,example.com chooses blocked HTTPS probe example.net` | 5,151.91 |
| `policy 3 allowlist example.org,example.com chooses blocked HTTPS probe example.net` | 5,005.88 |
| `policy 3 allowlist example.com:443 chooses blocked HTTPS probe example.net` | 5,015.14 |
| `policy 3 allowlist example.com:443/tcp chooses blocked HTTPS probe example.net` | 5,005.82 |
| `policy 3 allowlist  EXAMPLE.COM:443/tcp  chooses blocked HTTPS probe example.net` | 5,006.49 |
| `policy 3 allowlist example.com:80 chooses blocked HTTPS probe example.com` | 5,007.77 |
| `policy 3 allowlist example.com:443/udp chooses blocked HTTPS probe example.com` | 5,020.98 |
| `policy 3 allowlist example.com,example.net:443,example.org:443/tcp chooses blocked HTTPS probe ` | 6,016.13 |
| `a gateway workload records its egress once and verifies enforcement without running the firewall: the gateway has gone` | 5,009.14 |
| `the root entrypoint runs the firewall itself and records the outcome per mode` | 5,001.61 |

The corrected desktop suite passed both alone (`desktop-final`, 76.7 s) and in
the final aggregate (1,344 passed, 14 skipped, zero failures, 44.85 s). Final
rerun evidence is in `orkestrator-test-run.IKbrwf/` (groups) and
`orkestrator-test-run.Di3WV3/` (outer log).

The final default suite completed in 842.7 s: the workspace, bridge and protocol
lockfile groups passed; only the 12 firewall deadlines failed. `mise run check`,
the focused freshness/setup/packaging/lifecycle tests, and the ownership/runner
tests passed. No firewall assertions, skips or timeout budgets were changed.
