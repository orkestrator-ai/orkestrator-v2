# Cursor initial-run owner reaches Cursor's backend and times out on a slow network

- **ID:** 1530
- **Status:** open
- **Date observed:** 2026-10-24 (aggregate); reproduced 2026-10-31.
- **Test:** `replaces an unused warm agent when a read-only prompt changes its policy`, and three later cases in the same file
- **File:** `bridges/cursor-bridge/src/initial-run.test.ts:175`
- **First record:** [0790](../aggregate-validation-runs/0790-settings-machine-strip-validation.md),
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
