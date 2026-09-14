# Root-suite 5000 ms timeout cluster (`tests/unit/electron/`, `tests/unit/test-diagnostic-bounds.test.ts`)

- **ID:** 0043
- **Status:** resolved
Three tests failed together in one root-suite run, and three further runs each
failed a different subset. They are recorded as one entry because the evidence
points at a single shared cause — starvation against a fixed 5000 ms deadline —
rather than independent defects. Every owning file passes alone, and the failing
set is not stable between runs, which is the signature this registry already
records for the `tmux-backend.test.ts` and `standalone.test.ts` clusters below.

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4`
- **Worker configuration:** `--parallel=4` (which implies `--isolate`). Run concurrently with a second `bun test --test-worker` fleet from another worktree on the same host; load average during the run was 18.67 / 27.53 / 21.07.
- **Suite counts:** 3,733 passed, 1 skipped, 3 failed, 2 non-fatal between-test errors; 179 files in 341.4 s (exit 1).
- **Failures:**
  - `remote gateway > keeps a slow but progressing proxy body alive past the idle timeout` (`tests/unit/electron/gateway-proxy.test.ts:674`) — `expect(received).toBe(expected)`, expected `200`, received `502`.
  - `remote gateway > serializes invoke results once and keeps command metrics private and bounded` (`tests/unit/electron/gateway-support-extra.test.ts`) — timed out after 5000 ms (5034.33 ms), with an unhandled `ECONNREFUSED` between tests.
  - `Electron backend command registry > clears a stale failure only once the stop has actually committed` (`tests/unit/electron/commands-registry-environments.test.ts:3892`) — expected a promise that resolves, received one that rejected; timed out after 5000 ms (5002.20 ms).
- **Isolated reruns:** `bun test tests/unit/electron/gateway-proxy.test.ts` → passed, exit 0, 1.7 s. `bun test tests/unit/electron/gateway-support-extra.test.ts` → passed, exit 0, 2.1 s. `bun test tests/unit/electron/commands-registry-environments.test.ts` → also failed alone, but on **two different tests** than the aggregate run; all three originally-failing tests passed when selected individually with `-t`.
- **Recurrence (2026-08-17, same day):** Three further `bun test ./tests --parallel=4` runs on an otherwise idle host, each failing a **different** subset of 5000 ms-deadline tests:
  - Run 1 — none of this cluster failed.
  - Run 2 — `remote gateway > serializes invoke results once and keeps command metrics private and bounded` (5059.89 ms). 3,741 passed, 1 skipped, 1 failed, 179 files, 244.2 s. Isolated rerun of `gateway-support-extra.test.ts` → 23 passed, 0 failed, in **1.03 s**.
  - Run 3 — `bounded test diagnostics > never passes a DOM-producing query result directly to toBeNull` (`tests/unit/test-diagnostic-bounds.test.ts`, 5011.17 ms) and `Electron backend command registry > rejects malformed container status framing and invalid encoded sections` (`tests/unit/electron/commands-registry-environments.test.ts`, 5006.02 ms). 3,740 passed, 1 skipped, 2 failed, 361.4 s. Both owning files passed alone: 12 passed in 2.18 s, and 114 passed in 43.40 s.
- **Recurrence (2026-08-17, `claude-task-layout`):** one further occurrence of the same 5000 ms-deadline cluster, in the full four-group `scripts/test-all.ts` run rather than the root group alone: `Electron backend command registry > rejects malformed container status framing and invalid encoded sections` (`commands-registry-terminal.test.ts`, 5018.26 ms), alongside `scripts/test-all.ts > the non-iOS groups run concurrently, not one after another` (1008.70 ms) — see that test's own entry. The run took 229.6 s against ~137 s for the same command minutes earlier on the same tree, so the host was materially slower; both owning files passed alone immediately afterwards (64 passed and 32 passed, exit 0). No new evidence about mechanism, and the change under review touched only transcript settle positions in `apps/web`, `apps/backend/src/core/http-bridge-provider.ts`, `bridges/claude-bridge` message normalization and the protocol summary — none of which these files load.
- **Recurrence (2026-08-27):**
  `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures`
  reported 3,845 passed, one skipped, two failed, and two associated errors
  across 185 files in 237.76 s. `verifies a PR against the trusted project and
  environment branches` timed out at 5,021.86 ms, and `falls back to the parent
  directory when Linux FileManager1 fails` timed out at 5,001.17 ms. Their
  combined isolated rerun passed 117 tests in 14.23 s.
- **Widened scope:** run 3 shows the cluster is not confined to the gateway and command-registry files. `test-diagnostic-bounds.test.ts` walks every test file in the repository and needs 2.18 s even alone, so it sits close to the 5000 ms deadline before any contention is added; it is the clearest example of a deadline that is too tight for the work rather than a test that hangs. A test needing 1–2 s alone but exceeding 5 s under `--parallel=4` is being starved.
- **Hypothesis:** All three are fixed-deadline (5000 ms) assertions in files that spawn child processes and bind loopback ports. Under the observed load they lose the CPU long enough to cross the deadline, and the gateway proxy's `502` is the same starvation surfacing as an upstream connect failure rather than a timeout. The `commands-registry-environments.test.ts` file failing on a *different* pair of tests in isolation is the strongest evidence that the deadline, not any one test's logic, is what is being hit. A fix should replace the fixed deadlines in these three files with progress-based waits, or raise them proportionally to detected host load; do not simply widen the constant, which moves the threshold without removing the race.
- **Not attributable to the change under review:** the diff that surfaced this (`packages/protocol/src/action-defaults.ts` and the settings/toolbar wiring) touches none of these files or the code they exercise.
- **Recurrence (2026-08-27, `update-environment-modal`):** six of this cluster failed together in one `bun run test` (root and agent-support group: 3,853 passed, 1 skipped, 6 failed, 3 non-fatal between-test errors, 187 files in 211.7 s; the workspace, bridges and protocol-lockfile groups all passed). Every one was a 5,00x ms timeout:
  - `Electron backend command registry > keeps the stored branch when a container rollback outcome cannot be established` (`tests/unit/electron/commands-registry-environments.test.ts:2216`, 5,005.26 ms)
  - `Electron backend command registry > keeps the stored branch when a container rollback fails and the container is unreachable` (`tests/unit/electron/commands-registry-environments.test.ts:2276`, 5,003.91 ms)
  - `Electron backend command registry > stops container merges when draft inspection or readiness fails` (`tests/unit/electron/commands-registry-pr.test.ts:472`, 5,002.42 ms)
  - `Electron backend command registry > stops local merges when draft inspection or readiness fails` (`tests/unit/electron/commands-registry-pr.test.ts`, 5,022.30 ms)
  - `Electron backend command registry > treats empty, null, and non-boolean draft output as non-draft` (`tests/unit/electron/commands-registry-pr.test.ts`, 5,025.65 ms)
  - `Electron backend command registry > reports whether the selected host GitHub CLI credential is available` (`tests/unit/electron/commands-registry-tools.test.ts:840`, 5,010.40 ms)

  All three owning files passed alone immediately afterwards: `bun run test:logged -- --name env-registry -- bun test ./tests/unit/electron/commands-registry-environments.test.ts --only-failures` -> exit 0 in 30.9 s; `... --name gh-cred -- bun test ./tests/unit/electron/commands-registry-github.test.ts ./tests/unit/electron/commands-registry-pr.test.ts` -> exit 0 in 10.8 s; `... --name tools-registry -- bun test ./tests/unit/electron/commands-registry-tools.test.ts` -> exit 0 in 0.5 s. The failing set is again unstable between runs and spans three files, which is the same signature as every earlier occurrence. No new evidence about the mechanism. The change under review adds a reviewer fan-out to the build pipeline, a `create_feature_build` command and create-environment dialog work; none of these three files load any of it.
