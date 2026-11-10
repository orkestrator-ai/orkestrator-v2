# Cursor initial-run owner reaches Cursor's backend and times out on a slow network

- **ID:** 1530
- **Status:** resolved
- **Date observed:** 2026-10-24 (aggregate); reproduced 2026-10-31.
- **Test:** `replaces an unused warm agent when a read-only prompt changes its policy`, and three later cases in the same file
- **File:** `bridges/cursor-bridge/src/initial-run.test.ts:175`
- **First record:** [9888](../aggregate-validation-runs/9888-settings-machine-strip-validation.md),
  a five-second timeout (5,001.32 ms) in the aggregate; the 2026-10-25 triage
  in todo 0030 named this owner without a case.

## Reproduction (2026-10-31, Arch Linux, Bun 1.4.4)

The file sets `CURSOR_API_KEY=test-key` and drives the real SDK lifecycle and
store. Run in a private network namespace where loopback works and every
other connection hangs (a dummy interface as the default route, so a SYN gets
no answer):

```sh
unshare -rn bash -c 'ip link set lo up && ip link add dummy0 type dummy &&
  ip addr add 10.9.9.1/24 dev dummy0 && ip link set dummy0 up &&
  ip route add default via 10.9.9.2 &&
  bun test --preload ../../tests/setup-node.ts --parallel=1 src/initial-run.test.ts'
```

from `bridges/cursor-bridge`, four cases time out at 5 s:
`replaces an unused warm agent…`, `repairs a placeholder restored after a
bridge restart…`, `the transcript survives a replacement…` and `the picker
stops offering a warm agent…` (14 pass, 4 fail). `ss -tn state syn-sent`
inside the namespace shows three connections to port 443 of
`api2.cursor.sh`'s addresses within a second of the start. With the normal
network the file passes 18 of 18. Run alone with `-t`, `replaces an unused
warm agent…` passes even in the namespace; after `settingSources stay empty…`
it times out, so state left by the first test's attach waits on the request.

So the owner depends on Cursor's backend answering quickly: a slow or busy
network, as on a loaded aggregate host, turns the request into the recorded
timeouts. Stubbing the bridge's own model catalogue
(`useCursorModelsForTests`, committed with this case) did not remove it; the
request comes from the real SDK, not from `fetch` (a `fetch` wrapper saw no
outbound call).

- **Next step:** find which SDK call reaches `api2.cursor.sh` during the
  first test's attach (the platform's `createAgent`/`resumeAgent`, or a
  background call it starts) and stub it, or point the SDK at a closed
  loopback port for this file. Then rerun in the namespace above.
- No assertion, timeout or skip was changed.

## Resolution (2026-11-10)

- **Status:** resolved.
- **Root cause:** the test reached Cursor's real backend. With
  `CURSOR_API_KEY=test-key`, the real SDK's `send` starts
  `POST /auth/exchange_user_api_key` against `CURSOR_BACKEND_URL` (default
  `https://api2.cursor.sh`) to fetch its HTTP/2 server config, with no
  deadline. The bridge's model stub does not cover it. Why the earlier
  `fetch` wrapper did not record it was not investigated. The send itself
  returns (it rejects at the test's executor boundary), but disposing the
  agent waits for the request: `detachAgent` awaits
  `agent[Symbol.asyncDispose]()`. Instrumenting `replaces an unused warm
  agent…` showed every step before its final `detachAgent` completing, and
  that call never returning. A slow or unanswered backend therefore timed out
  each case that detaches after a send, the four recorded. A Cursor bridge
  whose network to Cursor hangs has the same unbounded detach in production.
  That is the SDK's behaviour and is not changed here.
- **Fix:** `bridges/cursor-bridge/src/initial-run.test.ts` sets
  `CURSOR_BACKEND_URL=http://127.0.0.1:0` before it loads the SDK (now a
  dynamic import, types from `import type * as Sdk`) and restores it in
  `afterAll`. Port 0 never accepts a connection, so the SDK's backend calls
  fail at once and offline on every platform. A whole-package run against a
  backend that never answers showed this is the only Cursor owner that
  reaches the backend: 916 pass, the same four fail.
- **Reproduced:** yes, on macOS. A local TCP server that accepts and never
  answers, passed as `CURSOR_BACKEND_URL`, made the unchanged owner fail
  exactly as recorded: 14 pass, 4 fail at 5 s, with one
  `POST /auth/exchange_user_api_key` logged by that server. Under the same
  server the fixed owner passed 18 of 18 and sent it no request.
- **Stress:** `mise run test:logged -- --name cursor-initial-run-1530 -- bun scripts/test-under-contention.ts --burners 4 -- bash -c 'cd bridges/cursor-bridge && for i in $(seq 10); do bun test --preload ../../tests/setup-node.ts --parallel=1 src/initial-run.test.ts || exit 1; done'`
  passed 10 of 10 fresh processes (unpinned burners on macOS).
