# openCodeSdkFetch read another body in the aggregate

- **ID:** 1146
- **Status:** resolved
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

## Investigation — 2026-11-06

Status stays open. The wrong bodies (`{}`, `{"error":"Unauthorized"}`, and `undefined` data in the sibling SDK-client case) look like responses from a different server, so the following were checked on Linux with Bun 1.4.0:

- `Bun.serve({ port: 0 })` listens on the dual-stack wildcard (`*:P` in `ss`). Another process cannot bind `127.0.0.1:P` beside it unless both sockets set `reusePort` (both attempts returned `EADDRINUSE`; with `reusePort` on both, the specific bind wins and answers `{}`). This fixture does not set `reusePort`, so port sharing by bind is ruled out unless another server set it too.
- An in-process probe ruled out a pooled keep-alive connection to an earlier server on the same port: a fetch after `old.stop()` and a rebind of the port reached the new server.

Not checked: a keep-alive connection to a server in a different process that stops listening but keeps serving open connections, and a sibling file's `HTTP_PROXY`/`http_proxy` (Bun's `fetch` honours them, and `process.env` is per worker process). Next step: when it recurs, record the worker's environment proxy variables and which other files that worker ran.

## Resolution (2026-11-10)

- **Root cause:** the fixtures listened with `Bun.serve({ port: 0 })`, which
  binds the dual-stack wildcard, while the requests went to
  `127.0.0.1:<port>`. On macOS a wildcard listener and another process's
  `127.0.0.1` listener can hold the same port at once, and a connection to
  `127.0.0.1` reaches the more specific one. The kernel picks a `port: 0`
  wildcard port without regard to IPv4 `127.0.0.1` listeners, so in a busy
  aggregate the fixture could be given a port a sibling worker's server
  already held on `127.0.0.1` (or the reverse), and its requests were
  answered by that server: the recorded `{}`, `{"error":"Unauthorized"}` and
  missing `data` bodies. The 2026-11-06 investigation ruled port sharing out
  on Linux, where the two binds conflict.
- **Fix:** `opencode-sdk-fetch.test.ts` binds every fixture to `127.0.0.1`
  (`hostname: HOST`) and requests that same address, so the kernel refuses
  or avoids a port another `127.0.0.1` listener holds. No assertion changed.
  Other suites use the same `port: 0` plus `127.0.0.1` pattern; they are not
  changed here.
- **Reproduced:** yes, as a held-port reproduction of the mechanism on this
  macOS host (Bun 1.4.x): with one process serving `Bun.serve({ port: 0 })`,
  a second process bound `127.0.0.1` on the same port and a `fetch` of
  `http://127.0.0.1:<port>/session` returned the second server's `{}`. In the
  reverse order, a wildcard bind on a port held by a `127.0.0.1` server that
  answers `{"error":"Unauthorized"}` succeeded and its fetch returned
  `{"error":"Unauthorized"}`, while the fixed shape (`hostname:
  "127.0.0.1"`) failed to bind (`Is port <port> in use?`). The aggregate
  collision itself depends on the kernel's random port choice and was not
  forced; the recorded observations did not name their platform.
- **Stress:** `mise run test:logged -- --name stress-opencode-sdk-fetch --
  bun scripts/test-under-contention.ts -- bun test --cwd apps/backend
  --preload ../../tests/setup-node.ts ./src/core/opencode-sdk-fetch.test.ts
  --rerun-each=50` passed (macOS, host load ~35 to 55).
