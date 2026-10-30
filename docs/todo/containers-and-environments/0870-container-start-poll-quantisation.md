# Container starts wait in 250 ms polls, which sets both their Docker call count and part of their latency

Checked against `main` at `79f3bc97` (2026-10-28).

A restricted runtime's start waits twice by polling: for its egress gateway's
firewall report (`waitForEgressGatewayFirewall`,
`apps/backend/src/core/egress-gateway.ts`) and for its own entrypoint's
boot status (`waitForContainerBoot`,
`apps/backend/src/core/container-readiness.ts:197-231`). Each poll is one
`docker exec` followed by a 250 ms sleep. So each wait finishes up to one
poll period (the sleep plus one exec) after the container actually got
there, and every poll is one more Docker call. A boot that is 50 ms slower
can cost a whole extra period. Found in
[0729](0729-container-benchmark-target-misses.md)'s attribution of the CI
benchmark misses.

## Task analysis

Analysed 2026-10-28 against `main` at `79f3bc97`.

### Tasks

1. **Bound the waits inside the container**: one exec waits for the state itself, up to a bounded window, instead of one exec per 250 ms. Status: done 2026-10-30 (`container-readiness.ts`, `egress-gateway.ts`; deterministic tests, and probe timings in the real image).
2. **Re-qualify the readiness faults**: the C09 fault cases and the gateway-cannot-apply case pass with the new wait. Status: done on Linux amd64, 2026-10-30. All nine live readiness cases passed in one run, plus four C09 stale-record and active-exec interruption checks. Explicit unused subnets bypassed the exhausted default pools without removing other runs' resources; fixture repairs and host prerequisites are recorded in the qualification evidence below.
3. **Re-measure the benchmark**: on CI and on the reference host, then tighten the calls target in `container-qualification.md` if the waits stop scaling with boot time. Status: open. Task 2 is qualified locally; repeated reference-host and CI measurements are still needed.

### 1. Bound the waits inside the container

**Problem.** Both waits are quantised to the poll period, and their call count tracks how long the boot takes, not what the start does.

**Context.** `observeContainerBoot` (`container-readiness.ts:132-170`) reads the boot status file once per exec. When the exec fails it backs off by up to 4× (`:227-229`), so an unreachable container polls more slowly still. The gateway wait now spends one call per unfinished poll (0729). `ensureCurrentBootReady` (`:238-246`) uses the same probe before dispatching work.

**Investigation.** From 0729's attributed benchmark runs (Docker Desktop 29.9.2 arm64, 18 CPUs, loaded host, 2026-10-28):
- In a fresh restricted start, boot readiness took 7 of 25 Docker calls, all `exec` polls, and the gateway firewall wait took 3.
- Warm start took 6 or 7 readiness polls out of 10 or 11 calls.
- Fresh `startToReady.ready` fell into two clusters one poll period apart:
  about 1.50 s (6 polls) and about 1.82 s (7 polls). The image at 0109's
  parent mostly took 6 and HEAD's mostly 7, so 0109's small per-boot cost
  (not pinned down; the relay copy itself is about 15 ms) shows up as a
  whole period of about 320 ms. That is the start-time rise 0729 explains.
- On CI, warm start on arm64 moved from 1.90 s (run 40409285999) to 2.28 s (run 40746551838) with no change to the boot path between them, which is the size of one or two poll periods.
- Certainty: the call counts are measured; how much of CI's start-time spread is quantisation, rather than runner noise, is inferred.

**Decisions.**

- **How should a wait observe the state?**
  - **One exec that checks the status file every 50 ms for up to 2 s and prints the last state; the caller loops on that (recommended).**
    - Pros: detection within about 50 ms; one call per 2 s window instead of about six; a stopped container still ends the exec, so failure detection is unchanged.
    - Cons: a long-lived exec per wait; the in-container loop must stay POSIX `sh` and bounded.
  - **`docker events` filtered to the container.**
    - Pros: push, no polling.
    - Cons: the entrypoint's status is a file, not a Docker event; still needs an exec to read it.
  - **Keep polling and lengthen the period.**
    - Pros: fewer calls.
    - Cons: worse start latency, against the start-time targets.

### 2. Re-qualify the readiness faults

**Problem.** A bounded in-container wait changes when the backend observes readiness and failure. Faster successful starts must still refuse failed, stale or incomplete boot reports.

**Context.** Task 1 changes both the runtime boot probe and the gateway firewall wait. C09 and the gateway-cannot-apply case in `container-live-readiness.test.ts` exercise failure admission against a real daemon.

**Investigation.** The existing live suite covers a missing firewall, DNS and permission failures, torn status writes, a restart during launch and a gateway that cannot apply its firewall. Deterministic tests should first cover bounded probe output and deadline handling; fake Docker alone cannot establish behavior when an exec is interrupted by an actual restart. Record the image digest and scenario results with the qualification evidence.

**Decisions.**

- **How should the new wait be qualified?**
  - **Run the deterministic readiness tests, then all existing live readiness-fault cases with a workspace-specific image (recommended).**
    - Pros: preserves the admission contract across actual restarts and failed boots; reuses established fault fixtures.
    - Cons: requires a disposable Docker test environment and a rebuilt image.
  - **Qualify only successful starts with the benchmark.**
    - Pros: produces latency evidence quickly.
    - Cons: cannot prove fail-closed behavior or current-boot identity after a restart.

### 3. Re-measure the benchmark

**Problem.** The current call budget includes one Docker exec per unfinished poll. Once task 1 changes that relationship, the call target and latency evidence need to reflect the new behavior.

**Context.** `container-benchmarks.test.ts` reports calls by phase, target and verb, plus separate gateway, runtime-start and readiness durations. `container-qualification.md` records a ≤ 27 call target and unchanged fresh and warm start-time targets. Task 2 must qualify failure behavior before the new timings count as release evidence.

**Investigation.** Compare repeated fresh and warm starts on both CI architectures and the Linux reference host using the same resource budget and attributed harness. Record runner shape, engine version, image digest, incomplete starts and readiness call counts. Compare multiple runs because 0729 measured substantial warm-start variance. A bounded wait can still need multiple exec windows for a slow boot, so any tighter budget must account for that rather than assume one call always suffices.

**Decisions.**

- **When should the calls target change?**
  - **Measure repeated qualified runs on CI and the reference host, then derive a tighter budget from the observed phases and bounded-window behavior (recommended).**
    - Pros: ties the target to an explained call count and retains visibility of regressions on both architectures.
    - Cons: needs a quiet reference-host window and CI evidence after tasks 1 and 2.
  - **Set the target from one local successful run.**
    - Pros: gives immediate feedback.
    - Cons: fits one host's boot time and can hide incomplete starts or runner variance.

## Current state

- `observeContainerBoot(id, { waitMs })` and the gateway's firewall read take
  a window. The exec re-reads its status file every 50 ms
  (`IN_CONTAINER_CHECK_MS`) for at most `PROBE_WINDOW_MS` (2 s), stops early
  on a final state, then prints what a single read prints, so
  `parseBootProbe` and the firewall report parser are unchanged.
- `waitForContainerBoot` and `waitForEgressGatewayFirewall` loop on those
  windowed reads. The window is clipped to the time left before the
  deadline, and the exec's timeout is extended by the window.
- Single-shot reads stay single: `ensureCurrentBootReady`'s first check,
  the agent MCP registry's boot read, and `prepareEgressGatewayForStart`'s
  read of a running gateway before it decides whether to restart it.
- Expected effect, not yet measured by the harness: a fresh restricted start
  spends about one readiness exec and no unfinished firewall reads instead
  of R = 6 or 7 and k ≥ 0. 0729's 16 + k + R becomes about 17, and
  `startToReady.ready` loses up to one poll period of quantisation.
- Probe timings on omarchy-hp with `--network none` containers of the image
  are in
  [container-qualification.md](../../development/container-qualification.md#bounded-readiness-probe-on-omarchy-hp-and-a-blocked-reference-host-run-2026-10-30).
- The subsequent real-daemon qualification, image digest, exact command and
  host-specific network/DNS/port prerequisites are in the
  [review follow-up](../../development/container-qualification.md#review-follow-up-on-the-same-daemon-2026-10-30).

## Outstanding work

### Qualification

The 29 older leaked probe networks remain untouched
([0241](0241-leaked-reach-probe-networks.md) task 5). They still block
automatic allocation, but explicit unused subnets allowed the live fault
qualification to complete. CI's "Container live qualification" workflow
also runs those suites on both architectures when the PR touches its paths.

- Task 3: the benchmark on omarchy-hp at the commit before this change and
  after it (this also closes 0729 task 5), and the next CI run's
  `freshRestricted.dockerCallBreakdown` (`boot.ready runtime exec`) and
  `startToReady.ready` on both architectures. Then decide the calls target.

## Assumptions and decisions

### Task 1: one bounded exec per window, 50 ms checks, 2 s window

Took the recommended option.

- The in-container check is only a cue to stop waiting. The exec still
  prints the same two lines as a single read, and the backend's parser
  decides what they prove, so a stale, torn or foreign record is refused
  exactly as before.
- The boot check matches the record's `pid1Start` against PID 1's own start
  time in the shell. Without that, an earlier boot's `ready` record would
  end every window at once. It relies on both writers putting `pid1Start`
  before `phase`; if that ever changes, the wait only stops early less
  often, it never admits more.
- A missing `/run/orkestrator` ends the window at once, so a legacy image
  still costs one exec. The gateway's report needs no `pid1Start` check:
  its `/run` is a fresh tmpfs per boot.
- The loop is bounded by a count, not a clock, which keeps it to POSIX
  `sh`. If `sleep` refuses `0.05`, the loop ends rather than falling back
  to a longer sleep.

### Task 1: keep `pollMs` as a floor, not a period

Not offered as an option.

- A read that waited out its window reads again at once. One that came back
  early with no final state waits out the rest of `pollMs` (250 ms), and an
  unreachable container keeps its 250 ms to 1 s backoff.
- Why: the early-return cases (a capable image's missing status directory,
  a record the shell matched but the parser refused, a failed exec) would
  otherwise turn into a busy loop of Docker calls.

### Task 1: leave the single-shot reads alone

Not offered as an option.

- `ensureCurrentBootReady`'s first check, the MCP registry's boot read and
  the gateway's restart decision ask "is it ready now?". A window there
  would hold a dispatch, or the decision to restart a failed gateway, for
  up to 2 s, and would save no call.

### Task 2: qualify in the real image with isolated subnets

The recommended option was the deterministic tests and then the full live
readiness-fault suite with a workspace image.

- The deterministic half is done: the generated scripts run under a real
  `sh` against a remapped status directory, directly and through a fake
  `docker` that executes them, covering an early stop, a stale record, a
  missing directory, one exec per window and the early-return floor; and
  the gateway's `applied` and `failed` reports seen in one read.
- The live suite ran and could not create a single environment network.
  The networks that fill the pools belong to other runs, and the
  delegation allowed removing only this run's resources, so I left them and
  kept the task open.
- To get some live evidence anyway, I ran the backend's probe functions
  against containers of the image on `--network none`: full-mode boots
  (old and new waits alternated), a restricted boot that fails closed, a
  stale record, and a restart and a stop mid-window. That proves the
  script in the image's `sh` and the exec ending with the container. It
  does not replace C09.
- Review follow-up completed C09 and the full nine-case live fault suite
  against the same image using explicit unused subnets. The permission
  fixture now pins its firewall inside the runtime, and C22 can select a
  free, already-admitted host-service port through the server's existing
  port preference. No host firewall rule or daemon configuration changed.
  New shell regressions cover deadline clipping and window renewal; a
  gateway regression covers its early-return polling floor. Two new live
  cases wait for Docker to register the active exec before stopping or
  restarting the container, so interruption is observed rather than assumed.

### Task 3: no new calls target

The recommended option was to derive a target from repeated qualified runs.
There were none, so `container-qualification.md` keeps ≤ 27. The expected
figure is in Current state.

## Constraints and rationale

- The probe stays content-free: it reads only the boot status and firewall
  report records, bounded as today (`MAX_BOOT_STATUS_BYTES`, `head -c 4096`).
- A failed or exited container must still be reported at least as fast as now.

## Related

- [0729-container-benchmark-target-misses.md](0729-container-benchmark-target-misses.md) (the attribution)
- [0241-leaked-reach-probe-networks.md](0241-leaked-reach-probe-networks.md) (what blocked the live runs)
- [Container lifecycle: readiness](../../architecture/container-lifecycle.md)
- [Benchmark harness and regression targets](../../development/container-qualification.md#benchmarks)

## Replaces

Nothing; new on 2026-10-28, split from 0729.
