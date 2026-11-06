# Egress probe listener startup in the default aggregate

- **ID:** 5961
- **Status:** resolved
- **Date observed:** 2026-11-05
- **Test:** `probe listeners serve only the fixed response, even from a directory containing files`; the same file's `cleanup after failed container create/start removes only successfully created resources` timed out alongside it
- **File:** `tests/unit/egress-gateway-qualification.test.ts:23`
- **Original command:** `mise run test:logged -- --name address-default-suite -- mise run test`, following commit `22506b26d`.
- **Worker configuration:** default concurrent aggregate; root group granted one worker, workspace five slots, bridges two slots, protocol lockfile one slot. Root output reports Bun 1.4.4 with `1x PARALLEL`.
- **Failure:** expected two ports, received zero after polling for the Python listener's ports file; test duration 2,266.70 ms.
- **Suite counts:** root and agent-support tests: 3,640 passed, 1 failed, 22,249 assertions across 3,641 tests in 185 files; 212.12 s execution time. Other aggregate groups had not all finished when this case was recorded.
- **Evidence:** root log in `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.yGrqlX/`, lines 197–211. The aggregate runner retains compressed failure output there when it finishes.
- **Isolated rerun:** `mise run test:logged -- --name address-egress-owner -- bun test tests/unit/egress-gateway-qualification.test.ts --parallel=1 --only-failures` passed the whole owning file, exit 0, in 7.2 s. Passing output was deleted by the runner.
- **Scope:** the test, `firewall-test-support.ts`, `scripts/egress-probe-server.py`, and `scripts/qualify-egress-gateway.sh` are unchanged in this native-tab selector branch.
- **Hypothesis:** the listener did not publish its ports within the polling window during the aggregate. The unchanged file passes alone; the child process's startup delay or failure cause was not established. Keep the assertions and investigate on recurrence.

## Cold realm boot review recurrence — 2026-11-06

Preparation at `04849e759` ran `mise run test:logged -- --name
review-default-tests -- mise run test`. The one-worker root group again expected
two ports and received zero (2,279.49 ms). Its complete totals are unavailable in
the captured excerpt; the concurrent workspace group hit its 300,000 ms
no-progress watchdog. Original evidence is retained in
`.orkestrator/review-artifacts/review-validation-13d4da17-25c8-45e9-a2c8-ab247f6cdc2b/validation-04.stderr.txt`.

The complete unchanged owning file passed alone with
`mise run test:logged -- --name address-root-failure-owners -- bun test
./tests/unit/egress-gateway-qualification.test.ts --parallel=1 --only-failures`
(exit 0, 1.1 s). Passing raw output was removed by the runner. The shared test
setup diff only resets renderer request limiters; it does not change the Python
listener. This establishes intermittence, not the startup cause. The case stays
open; no assertion, skip or timeout changed.


## Cold realm boot review recurrence — 2026-11-06

Recorded preparation at `54ab6d570` ran
`mise run test:logged -- --name review-default-tests -- mise run test`.
The fixed-response listener again returned zero ports (2290.13 ms); the same owner also timed out in both failed-container cleanup cases (5002.79/5002.85 ms).
The aggregate uses the repository scheduler (workspace group six slots;
bridge group two package slots with one Bun worker per bridge).

The complete unchanged owning file passed alone (exit 0, 1.1 s):

```sh
mise run test:logged -- --name address-egress-recorded-owner -- bun test ./tests/unit/egress-gateway-qualification.test.ts --parallel=1 --only-failures
```

Original evidence remains in
`.orkestrator/review-artifacts/review-validation-f3469fba-5332-4a76-a6d8-5a4f873cf90f/validation-04.stderr.txt`
and `orkestrator-test-run.gIhwSP` compressed group logs below the host temporary
directory. The isolated pass establishes intermittence, not a cause or a fix.
The case remains open; no implementation, assertion, deadline or skip changed.

## Root cause and fix — 2026-11-06

**Cause.** `scripts/egress-probe-server.py` subclassed `HTTPServer`, whose
`server_bind` names the server with `socket.getfqdn(host)`. On this host that
is a real PTR query to the system resolver even for `127.0.0.1` (it answers
`1.0.0.127.in-addr.arpa`), made once per listener before the ports file is
written. While the resolver is slow, the listener publishes nothing: the
fixed-response test polls for about 2 s and sees zero ports, and
`qualify-egress-gateway.sh` polls for 5 s, so the two cleanup cases exceed Bun's
5 s test deadline and leave the hung listener behind ("killed 1 dangling
process"). The same file's same-timestamp case, which runs `python3 -c` but
stops before the listener starts, kept passing. Python startup itself is not
the cause: 40 concurrent listener starts at load average 38 on 18 cores
published their ports in 97–340 ms.

**Reproduction.** A `sitecustomize.py` on `PYTHONPATH` that delays
`socket.getfqdn` by 1.5 s reproduced the fixed-response failure (zero ports,
2,218 ms) with the unchanged script. Delaying it by 2.6 s reproduced all three
recorded failures, both cleanup cases at 5,002 ms with
`killed 1 dangling process`, which is the aggregate signature.

**Fix.** `ProbeServer.server_bind` binds through `socketserver.TCPServer` and
records the bind address as `server_name`; the fixed-response handler never
reads it. A new test, `probe listeners publish their ports without consulting
the resolver`, makes `getfqdn` and `gethostbyaddr` raise. It failed against the
old script (`exited 1`, 135 ms) and passes with the fix. The polling helper now
stops early when the listener exits and reports its exit state and stderr.
No assertion or deadline was loosened.

**Verification.** `bun test tests/unit/egress-gateway-qualification.test.ts`:
5 pass, 0 fail, both normally and with the 2.6 s delayed resolver in place.

### Independent startup-budget repair — 2026-11-06

- **Additional reproduced condition:** a fixed readiness window in the test. The test waited for
  the Python listener's ports file with 100 × 20 ms polls, about two seconds
  in total, and then asserted. `scripts/egress-probe-server.py` publishes
  both ports with an atomic rename once both sockets listen, so the file is
  either missing or complete. "Received length 0" therefore means it had not
  appeared yet: Python start-up plus binding can outrun the two-second window on
  a loaded host. The resolver investigation above separately reproduced the
  recorded failures and removed that production dependency. The failure at 2,266.70 ms matches the window
  plus overhead.
- **Fix:** `tests/unit/egress-gateway-qualification.test.ts` waits for the
  listener's own readiness signal, the ports file, until the child exits or a
  20 s bound passes, with an explicit 30 s test budget. If the listener never
  publishes, the test now fails with the child's exit status and stderr rather
  than an empty array. Every assertion is unchanged.
- **Reproduction:** with a `python3` shim on PATH that sleeps 2.5 s before
  exec, the unchanged test failed with `Expected length: 2, Received length:
  0`, the recorded failure, and the fixed test passed. A shim that exits 3
  fails the fixed test at once with "probe listener published no ports (exit
  3, signal null): boom".
- **Verification:** `mise run test:logged -- --name env-egress-qual-stress --
  bun test tests/unit/egress-gateway-qualification.test.ts --parallel=2
  --rerun-each=20`: PASS in 28.3 s.

## Merge integration — 2026-11-06

The merged owner keeps both repairs: the probe avoids reverse DNS, and both
listener tests use the shared readiness helper with a 20 s startup bound and
30 s test budgets. The resolver-refusal regression and fixed-response
assertions remain intact. Earlier verification above describes the separate
pre-merge fixes.
