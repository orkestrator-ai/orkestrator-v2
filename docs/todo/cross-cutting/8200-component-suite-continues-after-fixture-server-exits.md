# The component suite keeps running after its fixture server exits

## Task analysis

Analysed 2026-11-15 against `main` at `a8b89f154`, on omarchy-hp (Omarchy,
Linux 7.2.8-9-omarchy, 12 cores, Playwright 1.65.0), while working to-do
7020 (retired 2026-11-16) task 2; its runs are recorded in
[agent-testing.md](../../development/agent-testing.md#loopback-namespace-qualification).

### Tasks

1. **Stop the component suite when its fixture server stops answering**: a `mise run test:browser` run whose Vite fixture server exited mid-run carried on for minutes and failed every later case with `net::ERR_CONNECTION_REFUSED`. Status: open.

### 1. Stop the component suite when its fixture server stops answering

**Problem.** In run `browser-ns-2` of 7020's task 2 (whole-suite `mise run
test:browser` at `a8b89f154`, started 2026-11-15 21:13 UTC in the loopback-only
namespace on omarchy-hp), the Vite fixture server started by
`e2e/playwright.config.ts`'s `webServer` exited between 21:30:11 (its last
output line) and the next navigation, at about case 371 of 1,904. It printed
nothing as it went. Playwright kept scheduling cases: 371 of the run's 447
failures were `page.goto: net::ERR_CONNECTION_REFUSED` at the fixture port,
and the run would have spent most of an hour failing the remaining 1,146
cases had it not been stopped by hand. A review-validation run in the same
state would report hundreds of failures that say nothing about the change
under review.

**Context.** Playwright watches its `webServer` process only while it starts:
in Playwright 1.65 the `onExit` handler rejects a promise that is raced only
against the startup URL check (`processExitedReject` in
`playwright/lib/runner/index.js`, "Process from config.webServer exited
early"). After startup an exit is not observed at all. The config's
`globalSetup` (`e2e/fixture-server-owner.ts`) runs once, before any worker,
and checks only that the server on the port belongs to this checkout.

**Investigation.** What stopped the server is not known. There was no core
dump for a Node or Vite process (`coredumpctl` listed only system Chromium
and another worktree's packaged Electron), no kernel or `systemd-oomd` kill,
and 19 GB of memory available. The host's load average was about 40 on 12
cores, from this run and another worktree's `test:browser`. The production
Orkestrator backend on the same host was down at the same moment (Tailscale
Serve logged `connection refused` on its port at 21:30:18, and its restart at
21:31:08 recorded `previous-run outcome=crashed`), so the server may have been
stopped by whatever stopped that backend
([process-crashes-and-kills.md](../../debugging/process-crashes-and-kills.md)).
Three cases just before it reported `Page crashed`.

**Decisions.**

- **How should the suite notice a dead fixture server?**
  - **Probe the fixture URL from `globalSetup` and stop the run after a few consecutive failures (recommended).** `globalSetup` may return a teardown; start an unref'd interval there that fetches `baseURL` every 10 s, and after three consecutive refusals log one line naming the port and end the run the way Ctrl-C does, so the reporter prints the summary and marks the rest "did not run".
    - Pros: one place, covers every spec without touching 140 files; the run ends within about 30 s of the server dying, with a message that says why.
    - Cons: Playwright has no API to abort from `globalSetup`, so it must interrupt its own runner (a SIGINT to `process.pid`, never a parent); the interval must be stopped in the teardown (AGENTS.md invariant 15).
  - **Set `maxFailures` in the config.**
    - Pros: one line.
    - Cons: also stops a run that is failing for real reasons (the load-sensitive cases in 7020 already reach dozens), and the message does not say the server died.
  - **Rely on review validation's retry.**
    - Pros: no change.
    - Cons: a retried case hits the same dead port; the run only gets longer.
- **Should the probe restart the server instead?**
  - **No: stop and report (recommended).** A restarted server hides the cause, and the cases already failed against the dead one would still count.
  - **Yes.**
    - Pros: the rest of the run could pass.
    - Cons: Playwright owns the server process; restarting it from outside means a second server lifecycle to keep correct.

## Related

- 7020 (retired 2026-11-16), whose qualification found this; its runs are in [agent-testing.md](../../development/agent-testing.md#loopback-namespace-qualification).
- [8201](8201-component-suite-default-workers-saturate-the-host.md), the suite's load at its default worker count.
- [testing-guide.md](../../development/testing-guide.md#watchdogs-and-stuck-processes), the runner's existing watchdogs.
