# ACP busy fork intermittently accepts

- **ID:** 2391
- **Status:** resolved
- **Test:** `POST /session/:id/fork > a busy source is refused before the fork extension`
- **File:** `bridges/acp-bridge/src/acp-fork.test.ts:318`

On 2026-11-01, notification-bar preparation `mise run test` expected HTTP 409 but received 200 after 587.14 ms. The captured output reports one Bun worker for ACP. Evidence: `.orkestrator/review-artifacts/review-validation-eb40d1d2-656b-44f0-9a8f-1c2970a9e415/validation-04.stdout.txt`.

The complete unchanged owner passed alone on the branch (5.4 s) and detached `origin/main` at `b965aea44` (4.9 s), with independently installed dependencies:

```sh
mise run test:logged -- --name fix-acp-fork -- bun test --cwd bridges/acp-bridge ./src/acp-fork.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

The main run used `--name baseline-acp-fork`. This establishes intermittency; it does not establish the cause. No bridge source, assertion, timeout or skip changed.

Seen again on 2026-11-01 in the shared-logger bridge migration: `mise run test:changed` expected 409 and received 200 after 212.42 ms, in the bridges group. The owner then passed alone three times (26 pass, 0 fail each):

```sh
bun test ./src/acp-fork.test.ts --preload ../../tests/setup-node.ts --only-failures
```

That change touches this bridge's logging but not its fork or prompt paths, so this adds a sighting, not a cause.


## PR pane review — 2026-11-02

`mise run test` reported HTTP 200 instead of 409 (329.65 ms). The unchanged complete owner passed on this branch (`fix-acp-owner`, 3.1 s), on detached `origin/main` d7cdfaa8b (`baseline-acp`, 2.9 s), and ten repeats there (`baseline-acp-repeat`, 25.6 s). No cause established. Preparation evidence remains in `.orkestrator/review-artifacts/review-validation-d66c3b2c-a4b1-42da-b180-8fa7b6582c7b/` (validation-04.stdout.txt and validation-05.stderr.txt). Browser preparation reported 1146 passed, 10 failed, 117 skipped, 3 flaky. Default-suite preparation reported two failed owners; aggregate worker grants were not retained in the package. No assertion, timeout, skip or implementation was changed in these owners.

## PR pane fix round 2 — 2026-11-02

Reproduced on detached `origin/main` `d7cdfaa8b` (fresh worktree, own
`bun install --frozen-lockfile`), host load average about 21:
`bun --cwd=bridges/acp-bridge test ./src/acp-fork.test.ts --preload ../../tests/setup-node.ts --only-failures --rerun-each=40`
failed this case 3 times (HTTP 200 instead of 409; 365.96, 718.68 and
517.23 ms), 1037 pass, 3 fail across 1040 runs (159.9 s). The failure is
present on `main` and intermittent with the owner alone, not only in the
aggregate. The PR pane branch changes no bridge code. No assertion, timeout,
skip or implementation changed.

On 2026-11-02, Docker image review preparation at `dc93f82df` repeated the
409/200 failure (278.54 ms) in `mise run test` (parallel ACP worker count
not captured in the compact report). Original evidence:
`.orkestrator/review-artifacts/review-validation-90ebf1c0-551d-4b2e-a6f7-9a0dfa8f8b79/validation-04.stdout.txt`.
The unchanged complete owner passed alone on the branch with
`mise run test:logged -- --name round3-acp-owner -- bun test --cwd
bridges/acp-bridge ./src/acp-fork.test.ts --parallel=1 --only-failures`
(exit 0, 3.2 s). Independently installed detached main `d7cdfaa8b` passed
the entire bridges group in `mise run test` (71.0 s); it reproduced the
separate SSE exit-143 failure. This sighting confirms intermittency, but
neither run reproduces the busy-fork defect on main, so independence is
not claimed from these runs.


## Fix — 2026-11-03, security H4 review

Preparation at `2e57421e186fc12082f8ab62381df952bae1e701` again returned
200 instead of 409 (483.13 ms) in `mise run test`. Evidence:
`.orkestrator/review-artifacts/review-validation-48856735-cbac-4ef5-8681-5d3394fca749/validation-04.stdout.txt`.
The unchanged owner passed alone (4.5 s):
`mise run test:logged -- --name acp-fork-alone -- bun test --cwd bridges/acp-bridge ./src/acp-fork.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`.

The fake agent's `DIRECT:` branch returned `end_turn` immediately without
consulting `FAKE_ACP_HOLD_TURN_FILE`. If it finished before the fork HTTP
request arrived, the source was legitimately idle. This branch changed direct
replies to use `whenReleased`, and made the busy-fork test explicitly observe
`running` before asserting 409. Assertions and timeouts remained intact.
The main-merge resolution below supersedes the direct-reply change.

The complete owner passed ten repetitions (44.7 s):
`mise run test:logged -- --name acp-fork-repaired -- bun test --cwd bridges/acp-bridge ./src/acp-fork.test.ts --preload ../../tests/setup-node.ts --parallel=1 --rerun-each=10 --only-failures`.
This resolves the test's lifetime assumption rather than changing production
fork admission. The fix is committed with the H4 concurrent-config repair.
## Feature-plan wake review repair — 2026-11-03

- **Original command:** `mise run test` at `409c2ec81`; Bun 1.4.4, 1
  isolated parallel worker(s) for this package in the saved output.
- **Failure:** Expected HTTP 409, received 200 (366.08 ms).
- **Suite counts:** partial observed totals: 34,621 passed, 9 distinct failures,
  186 skipped; some closing summaries were absent.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-c93bd96c-443b-41fa-a4a1-00fe777fe19a/validation-04.stdout.txt`.
- **Isolated rerun:** `mise run test:logged -- --name fix-recorded-fork -- bun test --cwd bridges/acp-bridge ./src/acp-fork.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed the unchanged owning file, exit 0
  in 4.4 seconds. No assertion, deadline, skip or implementation changed.
- **Assessment:** recurrence matches the existing open case; the isolated pass
  establishes intermittency, not a root cause. The original aggregate remains
  failed. Triage marked it related through a shared protocol import; this
  observation does not override that verdict.


## Root cause and fix — 2026-11-03

**Cause: the test, not the bridge.** The test set `FAKE_ACP_HOLD_TURN_FILE`
and sent `DIRECT:one`, expecting the turn to stay running until it wrote the
release file. The fake agent's `DIRECT:` branch
(`bridges/acp-bridge/src/testing/fake-agent-prompt-start.ts`) never consults
the hold file: it writes its answer and `end_turn` straight away. So the turn
raced the fork request: the 202, then the fork's HTTP round trip, against the
fake agent's reply and the bridge settling the turn to `idle`. When the reply
settled first, `forkAcpSession` saw an idle session and forked (HTTP 200).

The bridge itself is correct. The prompt route sets `state.dispatching = true`
synchronously after the busy check and `state.status = "running"` before
answering 202 (`src/acp-http.ts`, prompt route). `forkAcpSession` refuses while
either is set (`src/acp-fork.ts`). A fork that arrives while an accepted turn
is still running is always refused.

**Fix (test-only):** the fake agent gains a `HELD:<text>` prompt form. It
answers like `DIRECT:` but sends `end_turn` only once the hold file exists
(`whenReleased`). The busy-fork test sends `HELD:one`. It also asserts that the
session is still `running` after the 409, which proves the precondition the
test depends on. `DIRECT:` is unchanged, because five other ACP test files set
the hold file and also send `DIRECT:` prompts that must end at once. No bridge
source, deadline, skip or retry changed. The 409 assertion is as strict as
before.

**Verification (this worktree, Bun 1.4.4):**

- Before the fix: `for i in $(seq 1 40); do bun test --cwd bridges/acp-bridge ./src/acp-fork.test.ts -t "busy source" --preload ../../tests/setup-node.ts; done`
  gave 32 pass and 8 fail, each `Received: 200`.
- After the fix, the same loop: 40 of 40 passed.
- After the fix, three loops of 10 ran concurrently with a full-file run of
  `acp-fork.test.ts`: 30 of 30 passed, and the full file passed 26, failed 0.
- After the fix: `bun test ./src/acp-fork.test.ts --preload ../../tests/setup-node.ts --only-failures --rerun-each=40`
  (in `bridges/acp-bridge`) gave 1040 pass and 0 fail (153.2 s).
- `bun fmt --check` passed on both touched files. `bunx oxlint` reported no
  errors, only six existing unused-import warnings in lines 1-11 of
  `fake-agent-prompt-start.ts`, which this change does not touch. The
  acp-bridge `bun run typecheck` reported no type errors.

## Main-merge resolution — 2026-11-03

Both branches fixed the same test lifetime assumption independently. The merge
keeps main's explicit `HELD:` prompt and immediate `DIRECT:` replies, because
other ACP tests require direct replies to finish even with a hold configured.
The busy-fork test retains both branches' running-state assertions. The
security review evidence above records the earlier branch implementation; the
verification in the preceding section records main's implementation.
