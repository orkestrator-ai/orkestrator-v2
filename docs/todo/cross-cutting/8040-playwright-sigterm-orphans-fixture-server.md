# A terminated Playwright run leaves its fixture server running

## Task analysis

Analysed 2026-11-13 against `main` at `17d28238c`, on this build's Mac
(macOS 27.2, Playwright 1.65.0), while running `test:browser` for to-do
[7020](7020-browser-suites-after-network-churn-qualification.md) task 2.

### Tasks

1. **Stop a SIGTERM to the Playwright runner from orphaning its `webServer`**: the component suite's Vite fixture server outlives a runner that `test:logged`'s watchdog or deadline terminated. Status: open.

### 1. Stop a SIGTERM to the Playwright runner from orphaning its `webServer`

**Problem.** When `mise run test:logged` stops a `test:browser` run (its
no-output watchdog, or the 30-minute group deadline), the Vite fixture server
that `e2e/playwright.config.ts` starts as its `webServer` keeps listening on
the run's port after every other process of the run has gone. It happened on
both of 7020's timed-out macOS runs on 2026-11-13 (port 14722 each time; both
servers were stopped by PID after their identity was checked).

**Context.** `terminate` in `scripts/test-all.ts` sends SIGTERM to the
group's process group and SIGKILL one second later. Playwright's runner
handles only SIGINT (`FixedNodeSIGINTHandler` in
`node_modules/playwright/lib/runner/index.js`), so SIGTERM ends it at once,
without the teardown that kills the `webServer`. Playwright starts the
`webServer` in a process group of its own, so the group signal never reaches
it. Outside CI the config sets `reuseExistingServer`, so the next run from the
same checkout on the same port quietly reuses the orphan; on a shared host it
is also a leaked Node process per terminated run.

**Investigation.** A probe (not committed) started the 13-line
`e2e/AgentAccountStatus.spec.ts` with `--repeat-each=50` on a private port,
waited for the server to listen, and sent SIGTERM to the process it had
spawned. The server was still listening 3 s later both when Playwright ran
directly and when it ran through `scripts/loopback-network.ts`, so the
loopback wrapper does not cause it: the wrapper forwards the signal, and
Playwright does not act on it. Linux was not checked; the mechanism (signal
handling and the server's own process group) is the same there.

**Decisions.**

- **Where to fix it?**
  - **Translate SIGTERM into Playwright's own SIGINT shutdown in the runner process, from the e2e configs (recommended).** A handler installed only when the config is loaded by the runner (not in a worker, which already ignores SIGTERM) re-raises SIGINT, so Playwright runs its normal teardown, which stops the `webServer`.
    - Pros: fixes every caller that sends SIGTERM (the test runner, the scheduler, a person's `kill`); one place per config; no change to the runner's process handling.
    - Cons: depends on Playwright's teardown finishing inside the runner's one-second SIGKILL grace on a loaded host; must not fire inside workers.
  - **Make `test:logged`'s terminate send SIGINT first and wait longer before SIGKILL.**
    - Pros: one place for every group.
    - Cons: changes the termination path of every suite, not just Playwright ones, and a longer grace delays every watchdog stop.
  - **Record the `webServer`'s PID and kill it from a global teardown.**
    - Pros: independent of Playwright's signal handling.
    - Cons: a global teardown does not run when the runner dies of SIGTERM, which is the case to fix.

## Constraints and rationale

A fix must signal only processes the run itself started, through a handle or
PID recorded at spawn time (AGENTS.md, "Production Orkestrator shares this
host"); never stop a server by port or by name.

## Related

- [7020](7020-browser-suites-after-network-churn-qualification.md), whose macOS qualification found it.
