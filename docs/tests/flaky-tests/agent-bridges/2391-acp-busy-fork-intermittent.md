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
