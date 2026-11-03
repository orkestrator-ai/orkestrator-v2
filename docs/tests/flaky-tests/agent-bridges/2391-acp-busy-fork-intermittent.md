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
request arrived, the source was legitimately idle. Direct replies now use
`whenReleased`, and the busy-fork test explicitly observes `running` before
asserting 409. Assertions and timeouts remain intact.

The complete owner passed ten repetitions (44.7 s):
`mise run test:logged -- --name acp-fork-repaired -- bun test --cwd bridges/acp-bridge ./src/acp-fork.test.ts --preload ../../tests/setup-node.ts --parallel=1 --rerun-each=10 --only-failures`.
This resolves the test's lifetime assumption rather than changing production
fork admission. The fix is committed with the H4 concurrent-config repair.
