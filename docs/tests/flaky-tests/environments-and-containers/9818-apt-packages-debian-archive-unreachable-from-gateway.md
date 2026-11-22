# Declared Debian packages: Debian's archive unreachable from a gateway runtime on CI

- **ID:** 9818
- **Status:** open
- **Date observed:** 2026-11-14 (first), 2026-11-20 (latest)
- **Test:** `declared Debian packages (to-do 7770) > a restricted gateway runtime installs a declared package and refuses denied ones`
- **File:** `apps/backend/tests/container-live-apt-packages.test.ts`
- **Host:** GitHub Actions, workflow "Container live qualification", step
  "Live declared Debian packages" (`bun test ... ./tests/container-live-apt-packages.test.ts --parallel=1`),
  Docker Engine 28.0.4, the qualification image built in the same job.

## Observations

The archived workflow jobs list 58 entries for this step from 2026-11-13
through 2026-11-20. Of the 56 executions, 52 passed (27 arm64 and 25 x64)
and four failed. Two entries were skipped, one per architecture in
[run 43763628463](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/43763628463).
Every failure is the same: `orkestrator-apt-install`'s `apt-get update` inside the gateway runtime
could not reach `deb.debian.org` (`Ign:1 https://deb.debian.org/debian trixie InRelease`,
then exit 5, "Debian's archive could not be reached"), and the assertion that
failed is whichever install the test was running at that moment.

| Run, job | Head | Architecture | Failed assertion |
| --- | --- | --- | --- |
| 44798394856, 136503831616 | `7a6a2f0b0` (#2519) | x64 | concurrent `openntpd`/`chrony` statuses `[5, 6]`, expected `[0, 3]` (line 226) |
| 44713559574, 136211083273 | `2abbde98b` | x64 | `sud.` refusal: the output was `apt-get update`'s unreachable archive (line 205) |
| 43562483619, 132349009264 | `474e750da` | x64 | concurrent statuses `[5, 6]` (line 226) |
| 43539711708, 132277151080 | `90439ccb0` | arm64 | `Installed: hello` missing; `apt-get update` unreachable (line 184) |

In each of those runs the step did not fail on the other architecture.

- **Isolated rerun:** not run. This host may not restart or reconfigure
  Docker or its firewall, and the live suite builds and drives gateway
  runtimes.
- **Recurrence check:** not in the registry before; no other case names this
  test.

## Hypothesis

Unconfirmed. The installer and its refusals behave as designed; what fails
is reaching the archive through the runtime's egress gateway. `deb.debian.org`
is served from a CDN whose answers rotate, and the gateway allows addresses,
so a lookup inside the runtime that returns an address the gateway's set does
not yet hold would be refused until the refresher adds it. A plain outage of
the archive from GitHub's network would look the same. The next failure should
record the gateway's network status (`resolvedDomains`, `refusals`) and the
address `apt-get` tried, which separates the two.

No test, wait or assertion was changed.
