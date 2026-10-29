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

1. **Bound the waits inside the container**: one exec waits for the state itself, up to a bounded window, instead of one exec per 250 ms. Status: open.
2. **Re-qualify the readiness faults**: the C09 fault cases and the gateway-cannot-apply case pass with the new wait. Status: open (depends on 1).
3. **Re-measure the benchmark**: on CI and on the reference host, then tighten the calls target in `container-qualification.md` if the waits stop scaling with boot time. Status: open (depends on 1).

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

## Constraints and rationale

- The probe stays content-free: it reads only the boot status and firewall
  report records, bounded as today (`MAX_BOOT_STATUS_BYTES`, `head -c 4096`).
- A failed or exited container must still be reported at least as fast as now.

## Related

- [0729-container-benchmark-target-misses.md](0729-container-benchmark-target-misses.md) (the attribution)
- [Benchmark harness and regression targets](../../development/container-qualification.md#benchmarks)

## Replaces

Nothing; new on 2026-10-28, split from 0729.
