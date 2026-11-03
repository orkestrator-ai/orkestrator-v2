# openCodeSdkFetch read another body in the aggregate

- **ID:** 1146
- **Status:** open
- **Observed:** 2026-10-27, todo 0223 branch validation
- **Test:** `openCodeSdkFetch > charges one provider request per call to the job that made it`
- **File:** `apps/backend/src/core/opencode-sdk-fetch.test.ts:19`

Failed once in the second `mise run test` of the 0223 branch (9.58 ms): the
response text from the test's own `Bun.serve` fixture was expected to be `ok`
but was `{}`, as if the request reached another handler or a replaced global
`fetch`. The 0223 change does not touch `opencode-sdk-fetch.ts` or the OpenCode
provider's transport.

The complete unchanged owner passed alone on the branch and on a detached
worktree of its base `863b57821` (5 passed each):

```sh
bun test --cwd apps/backend --preload ../../tests/setup-node.ts src/core/opencode-sdk-fetch.test.ts
```

A sibling file's global `fetch` stub leaking into this worker is a hypothesis;
nothing here establishes it. No assertion, skip or implementation changed.
Aggregate evidence: `orkestrator-test-run.38P3gc` under the host temporary
directory.

## PR management review validation — 2026-10-31

The exact `mise run test` rerun after repairing preparation's duplicate
flake IDs and installing the pinned Codex binary failed only
`openCodeSdkFetch > charges one provider request per call to the job that made it`
in `apps/backend/src/core/opencode-sdk-fetch.test.ts:19`. The expected body
was `ok`, but the observed body was `{"error":"Unauthorized"}` (3.95 ms).
Bun 1.4.4 reserved workspace/root/bridges/protocol groups at 6/1/2/1 worker
slots; the backend ran with two workers. Backend reported 11,484 passed,
103 skipped and one failed across 780 files (94.45 seconds). Root, bridges
and protocol groups passed. Aggregate evidence:
`orkestrator-test-run.uz9UiV/review-default-tests.log.gz` and
`orkestrator-test-run.hFxJlJ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
in the host temporary directory.

The complete unchanged owner passed alone, exit 0, in 0.4 seconds (five tests):

```sh
mise run test:logged -- --name opencode-fetch-owner -- bun test --cwd apps/backend ./src/core/opencode-sdk-fetch.test.ts --parallel=1 --only-failures
```

The response again appears to come from another handler, but the cause
remains unconfirmed. No OpenCode implementation, fixture, assertion, deadline
or skip changed.

## Todo 0051 validation — 2026-10-31

`mise run test` on the 0051 branch failed this test again, with the `{}` body
(4.30 ms). The backend reported 11,674 passed and two failed. The other failure
was the Codex title runner's `Pinned Codex CLI not found`, because the worktree
has no `binaries/codex`; it passes with `CODEX_PROTOCOL_BINARY` set, and is no
flake. The 0051 change touches neither `http-bridge-transport.ts` nor the OpenCode
provider. Aggregate evidence: `orkestrator-test-run.Ra7vlM` under the host
temporary directory.

The complete unchanged owner passed alone three times out of three (five tests):

```sh
bun test --cwd apps/backend ./src/core/opencode-sdk-fetch.test.ts --parallel=1 --only-failures
```

The cause remains unconfirmed. No assertion, skip or implementation changed.

## Coordinator environment-choice review, 2026-11-03

Preparation at `d2efad0d6` ran `mise run test` and failed the sibling test
`openCodeSdkFetch > the provider's default SDK client charges its requests`
at line 54 (expected [], received undefined, 9.91 ms). Original evidence:
`.orkestrator/review-artifacts/review-validation-b82eab29-3f18-42ce-8dd3-4d2e4a59a7a0/validation-04.stdout.txt`.
The workspace and bridge groups failed; root and protocol groups passed.
Preparation used the package scripts' configured parallel worker counts.

The complete owner passed alone through
`mise run test:logged -- --name opencode-fetch-owner -- bun test --cwd apps/backend ./src/core/opencode-sdk-fetch.test.ts --parallel=1 --only-failures`
(exit 0, 0.3 s). A detached `origin/main` at `eda57e938`, with its own frozen
install, also passed this owner in 20 repeats in a three-owner run (680 pass,
20 fail, all failures in PreviewUpstreamPool). The exact aggregate failure
has not been reproduced on main by these focused runs. The cause remains
unproven; no OpenCode implementation, test assertion or timeout changed.
