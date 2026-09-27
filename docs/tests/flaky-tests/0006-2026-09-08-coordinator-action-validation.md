# 2026-09-08 coordinator action validation

- **ID:** 0006
- **Status:** open
- **Original command:** `bun run test:logged -- --name composite-full-suite -- bun run test`
  with the default eight-worker aggregate budget (four root workers, two bridge
  workers, two workspace workers). The root group reported 4068 pass, 3 skip,
  5 fail in 127.37s. Two failures were a new import cycle corrected in this
  change; one was a pre-existing unbounded DOM assertion corrected in this
  change. Those three are deterministic defects, not flakes.
- **`Electron backend command registry > rejects a local HEAD that git did not
  report as a commit sha`**, `tests/unit/electron/commands-environment.test.ts`:
  fixture `git commit -m base` exited with `signal: SIGKILL`, no output, with
  the case reported at 77.46ms. No cause established; this is not evidence that
  the command's Git validation failed.
- **`remote gateway > closes an established event stream when its agent-test
  session expires`**, `tests/unit/electron/gateway-auth.test.ts`: the harness
  received the connected frame but could no longer find its registered client
  (`Gateway did not register the event-stream client`, 48.73ms). Early session
  expiry under aggregate scheduling is a hypothesis, not a confirmed cause.
- **Isolated reruns:** both passed with exit 0 using
  `bun run test:logged -- --name composite-root-git-isolated -- bun test ./tests/unit/electron/commands-environment.test.ts --parallel=2 --only-failures`
  (1.1s) and
  `bun run test:logged -- --name composite-root-gateway-isolated -- bun test ./tests/unit/electron/gateway-auth.test.ts --parallel=2 --only-failures`
  (0.8s).
- **Failure evidence:** `/tmp/orkestrator-test-run.p4oV62/summary.json` and
  `/tmp/orkestrator-test-run.p4oV62/root-and-agent-support-tests.log.gz`.
- **2026-09-21 fixture correction:** the event-stream case now establishes the
  real loopback connection while the session has its normal lifetime, captures
  the production expiry callback, then expires the credential and invokes that
  callback. This removes the 40 ms connection/expiry race while retaining the
  client-abort and server-client-map assertions. The broader case remains open
  until the registry's normal aggregate recurrence criteria are satisfied.

### Subsequent aggregate timeout cluster

- **Status:** open; all owning files passed when run serially in isolation.
- **Original command:** `bun run test:logged -- --name composite-full-suite-final -- bun run test`,
  same default eight-worker configuration. Root: 4068 pass / 3 skip / 5 fail
  (293.64s); backend: 2751 pass / 3 fail (335.43s); bridges: 3423 pass /
  16 skip / 1 fail (298.31s). Protocol passed; Turbo stopped before finishing
  the remaining workspace tasks after the backend failure.
- **Failures:**

| Owning file | Exact test name | Failure / duration |
| --- | --- | --- |
| `tests/unit/pi-bridge-vendor.test.ts` | Pi bridge runtime vendoring > loads Pi's undeclared server import from the staged runtime closure | 30,000ms timeout / 30,004.20ms |
| `tests/unit/electron/commands-integration.test.ts` | Electron backend command registry > persists safe cleanup failure details and permits a backend deletion retry | 5,000ms timeout / 6,722.09ms |
| `tests/unit/electron/commands-registry-pr.test.ts` | Electron backend command registry > persists merge cleanup intent before dispatch and completes local cleanup in the backend | 5,000ms timeout / 7,295.39ms |
| `tests/unit/electron/commands-registry-pr.test.ts` | Electron backend command registry > continues confirmed cleanup when persisting merged PR state fails once | 5,000ms timeout / 6,423.57ms |
| `tests/unit/electron/commands-io-coverage.test.ts` | backend command I/O coverage > reports the HEAD and uncommitted paths of a local environment worktree | 5,000ms timeout / 5,001.20ms |
| `apps/backend/src/core/commands-state-sync.test.ts` | initial prompt attachment command > accepts twenty attachments and rejects the twenty-first | 5,000ms timeout / 5,002.65ms |
| `apps/backend/src/core/commands-state-sync.test.ts` | initial prompt attachment command > allocates a safe unique name for every hostile or colliding attachment name | 5,000ms timeout / 5,003.55ms |
| `apps/backend/src/core/coordinator-service.test.ts` | project coordinator > retention never removes an open conversation | 5,000ms timeout / 5,250.71ms |
| `bridges/acp-bridge/src/acp-http.test.ts` | ACP bridge > reaps a session process when the creating HTTP client disconnects | Timed out waiting for ACP state: empty string / 5,644.46ms |

- **Isolated reruns:** exit 0 for all three logged commands below. Each used
  one worker, so owning files ran separately, with no concurrent file pool:
  - `bun run test:logged -- --name composite-timeout-owners -- bun test ./tests/unit/pi-bridge-vendor.test.ts ./tests/unit/electron/commands-integration.test.ts ./tests/unit/electron/commands-registry-pr.test.ts ./tests/unit/electron/commands-io-coverage.test.ts --parallel=1 --only-failures` (37.8s).
  - `bun run test:logged -- --name composite-backend-timeout-owners -- bun test --cwd apps/backend src/core/commands-state-sync.test.ts src/core/coordinator-service.test.ts --parallel=1 --only-failures` (17.6s).
  - `bun run test:logged -- --name composite-acp-timeout-owner -- bun test ./bridges/acp-bridge/src/acp-http.test.ts --parallel=1 --only-failures` (10.1s).
- **Evidence:** `/tmp/orkestrator-test-run.Cun1t8/summary.json` and its compressed
  group logs. Host contention is a hypothesis supported by broad elapsed-time
  inflation and clean serial reruns, not an established root cause. No budgets
  or assertions were loosened.
- **Recurrence:** `bun run test:logged -- --name composite-complete-suite -- bun run test`
  passed root, bridges and protocol; backend reported 2753 pass / 1 fail /
  1 error (174.48s). The twenty-attachment case timed out at 5,000.22ms; its
  outstanding promise then rejected after fixture cleanup. Evidence:
  `/tmp/orkestrator-test-run.VvdzNy/summary.json`. This is the same timeout,
  not another new product failure.
- **Complete reduced-worker run:**
  `bun run test:logged -- --name composite-suite-four-workers -- bun -e 'await import("./scripts/test-all.ts").then(({ main }) => main({ cores: 4 }))'`
  passed every group (684.1s). This uses the runner's existing four-worker plan:
  one root worker, two bridge workers, one workspace worker, with one workspace
  package at a time. No test exclusion, assertion, or timeout changed. The
  aggregate-only timeout remains open; a green reduced-worker run does not
  establish its root cause.
