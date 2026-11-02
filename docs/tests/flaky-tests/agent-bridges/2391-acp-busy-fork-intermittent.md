# ACP busy fork intermittently accepts

- **ID:** 2391
- **Status:** open
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
