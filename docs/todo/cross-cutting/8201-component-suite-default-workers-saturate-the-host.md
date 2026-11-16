# The component suite's default workers saturate a 12-core host

## Task analysis

Analysed 2026-11-16 against `main` at `a8b89f154`, on omarchy-hp (Omarchy,
Linux 7.2.8-9-omarchy, 12 cores, 30 GB, Playwright 1.65.0), from the runs that
closed to-do 7020 (retired 2026-11-16; recorded in
[agent-testing.md](../../development/agent-testing.md#loopback-namespace-qualification)).

### Tasks

1. **Decide whether the component suite's default worker count should follow what the host can carry**: at Playwright's default (half the cores), `mise run test:browser` alone drove a 12-core host from load 4 to about 30 and failed 150 of 1,904 cases, nearly all test timeouts that passed on rerun. Status: open.

### 1. Decide whether the component suite's default worker count should follow what the host can carry

**Problem.** The whole-suite run of 2026-11-15 (`mise run test:browser` at
`a8b89f154`, 6 workers, private ports) started at load average 3.9 and was
at 28.9 two minutes later; it stayed between 27 and 41 for its 91 minutes.
Other builds used about 1 to 5 cores during it (another worktree's Electron
specs and a `bun test`); the rest was the suite: six Chromium renderers at
roughly 50 to 65 % each, their browser and GPU processes, the Vite fixture
server and the workers. It failed 150 cases, 131 of them test timeouts
(30 s), with 75 `page.goto` or `page.reload` timeout errors among them. Of
the 139 failing cases that ran again in both follow-up reruns of the same 41
files, 97 passed both times. A person running the suite on a laptop sees a
red run that is mostly noise.

**Context.** `e2e/playwright.config.ts` takes
`ORKESTRATOR_VALIDATION_GRANTED_WORKERS` from review validation and otherwise
uses Playwright's default, `floor(cpus / 2)`, never more. Review validation
already grants fewer workers on a busy host. 7020 had rejected lowering the
default because it "changes every run, idle hosts included, to cover a busy
one"; this run is the evidence that an idle 12-core host becomes the busy
host at the default. Flakes [0382](../../tests/flaky-tests/web-ui/0382-component-browser-parallel-load.md)
and [5361](../../tests/flaky-tests/web-ui/5361-sidebar-drag-timeouts-under-load.md)
record the same cases failing under load.

**Investigation.** Not yet measured: the same whole run at 3 or 4 workers on
this host (duration and failures), and whether a 16-core host (beelink) at 8
workers saturates the same way. The 2026-11-10 sample on beelink passed 70 of
70 at 2 workers and at 8 workers when the host's load was 29, and failed at 8
workers when it was near 100, so the failures follow total load, not the
worker count alone.

**Decisions.**

- **What should decide the component suite's worker count outside review validation?**
  - **Measure first: run the whole suite at 3, 4 and 6 workers on omarchy-hp when nothing else runs, and set the default from the result (recommended).** If 4 workers finish in about the same time with a small fraction of the failures, use `floor(cpus / 3)` as the default and keep the review grant as the upper limit.
    - Pros: decided from this suite's own numbers; review validation keeps working as it does now.
    - Cons: three runs of about 90 minutes each on a quiet host.
  - **Keep half the cores.**
    - Pros: no change; the fastest wall time on a host with spare capacity.
    - Cons: a person's run on a 12-core host fails about 8 % of cases on load alone.
  - **Raise the 30 s test timeout.**
    - Pros: fewer timeouts at any load.
    - Cons: slows every genuinely stuck case, and hides real waits that grew.

## Related

- 8200 (retired 2026-11-16), the other finding from the same runs: the suite now stops when its fixture server stops answering ([testing-guide.md](../../development/testing-guide.md#watchdogs-and-stuck-processes)).
- [testing-guide.md](../../development/testing-guide.md), worker grants and review validation.
