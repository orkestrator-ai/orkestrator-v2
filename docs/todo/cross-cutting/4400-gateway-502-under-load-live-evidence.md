# Gateway 502s under load: live evidence still needed

## Task analysis

Analysed 2026-11-05 against `main` at `a0a6d6206`. The lab results below date from 2026-11-04, against `main` at `96ee1eb3e`. Rechecked 2026-11-11 against `main` at `498b68766`: the 120 s keep-alive (`GATEWAY_KEEP_ALIVE_TIMEOUT_MS`), `WORKLOAD_NICE` 10 and the burst summary (`GATEWAY_TRAFFIC_BURST_THRESHOLD`) are all still in place.

### Tasks

7. **Stop one short stall from resetting a whole batch**: macOS resets every connection past a 128-deep accept queue. Status: blocked (waits on 7568: 4400 task 6).

Tasks 1, 2, 3, 5 and 6 (Serve proxy-error counts and logs on the user's nodes, a run through real Tailscale Serve, the container measurement on a rootful Docker host, and naming the burst sender from arktech-mini's log) moved to [7568](../manual-test/7568-manual-test-checklist.md) on 2026-11-10. Task 4 (measuring nice 10 on macOS) followed on 2026-11-11; see Assumptions and decisions.

### 7. Stop one short stall from resetting a whole batch

**Problem.** A 10 ms stall while about 250 connections arrive resets about 122 of them, and Serve turns each reset into an empty 502.

**Context.** macOS caps every accept queue at `kern.ipc.somaxconn` (128 here). A larger backlog passed to `listen` cannot exceed it. Go does not retry a failed POST, and invoke must not be retried (see Constraints).

**Investigation.** Not started; it depends on what task 6 (now in [7568](../manual-test/7568-manual-test-checklist.md)) finds.

**Decisions.**

- **Which lever?**
  - **Cap the sender's concurrency once task 6 names it (recommended).**
    - Pros: removes the batch at its source; no system setting changes.
    - Cons: waits on task 6.
  - **Raise `kern.ipc.somaxconn`.**
    - Pros: immediate, protects every client.
    - Cons: a system setting that needs root and a LaunchDaemon to persist; it only widens the margin.

## Assumptions and decisions

### Task 6: a burst is 100 connections or requests in one second

Quiet periods on arktech-mini held 14 to 35 sockets in `TIME_WAIT`, under two new connections a second, while the bursts reset over 120 connections in 10 ms. A threshold of 100 a second sits far above normal use and well below a burst. It is one constant, `GATEWAY_TRAFFIC_BURST_THRESHOLD`.

### Task 6: one line per burst, at most one every 30 s

A burst ends after five quiet seconds; one closer than 30 s to the previous line is merged into it, and one still running after 60 s is written and restarted. This keeps an 80-second burst to two lines while still dating each one. Per-second lines were rejected because one burst would write dozens.

### Task 6: `X-Forwarded-For` is believed only from loopback

Serve connects from loopback, so that is the only peer whose header means anything. A direct tailnet client could put any text in the header, so it is ignored for direct peers, and anything that is not an IP literal is logged as `invalid`. Invoke commands are recorded only under the name the gateway's metrics already accept (`normalizeMetricLabel` of a registered command), never the arguments.

### Task 4: moved to the manual-test checklist (2026-11-11)

Measuring nice 10 on macOS needs a Mac, and the question it answers (does
the job move to efficiency cores?) is read with `powermetrics`, which runs
only as root. This pipeline ran on beelink2 (Linux, x86_64), and running a
CPU burner and a root tool on one of the user's Macs is theirs to allow, so
the measurement is now an item in
[7568](../manual-test/7568-manual-test-checklist.md) naming this task. What
the source reading predicts, kept for whoever runs it: in XNU, nice sets task
importance and a thread's base priority becomes 31 minus nice
(`resetpriority`, `task_policy.c`); threads with an explicit QoS class ignore
it (`thread_recompute_priority`); `sched_convert_pri_to_bucket` keeps
priority 21 in the default bucket, and priority 20 and below drop to utility;
nothing in that path sets the throttling that `taskpolicy -b` does. If nice
10 turns out to slow idle work on Apple Silicon, the recommended response is
to lower `WORKLOAD_NICE` (one constant, weaker protection under load) rather
than skip lowering on macOS, which would drop the protection where the
highest load was reported.

## Current state

Shipped with this file: a 120 s gateway keep-alive and nice 10 for agent and build work. See "Through Tailscale Serve" in `docs/architecture/remote-gateway.md` and "Workload priority" in `docs/architecture/backend-runtime.md`.

### Lab results

Setup: a real `OrkestratorGateway` with a fake backend, behind a Go `httputil.ReverseProxy` using Serve's transport values, with one idle pool per lane. Everything was pinned to two cores of a 16-core machine that was also running other builds, so "no load" means no load from this test. A "burner" is a busy-loop shell. Gaps are the idle time before each POST.

| Keep-alive | Load on the two cores | Gap range | 502s |
| --- | --- | --- | --- |
| 5 s (Bun's default; closes at 6.0 s) | none | 5.95-6.02 s | 7/1680, 6/1680 |
| 5 s | 16 burners, nice 0 | 5.95-6.02 s | 14/1680, 16/1680 |
| 5 s | 16 burners, nice 10 | 5.95-6.02 s | 0/1680, 1/1680, 1/1680 |
| 5 s | none | 5.5-6.5 s | 0/1200 |
| 5 s | 8 burners, nice 0 | 5.5-6.5 s | 1/1200 |
| 5 s | event loop blocked 300 ms each second | 4.5-7 s | 2/840 |
| 5 s | blocked as above, plus 16 burners | 4.5-7 s | 2/840 |
| 120 s | none | 5.95-6.02 s | 0/1680 |
| 120 s | 16 burners, nice 0 | 5.95-6.02 s | 0/1680 |
| 120 s | event loop blocked 300 ms each second | 4.5-7 s | 0/840 |
| 120 s | blocked as above, plus 16 burners | 4.5-7 s | 0/840 |
| 120 s | 8 burners, nice 0 | 88-92 s | 0/120 |

Without load the 502s fell at gaps of 5997-6000 ms. Under 16 burners they ranged from 5951 to 6019 ms, the whole range sampled.

Gateway round trip through the proxy with 16 burners, 2400 requests each: burners at nice 0 gave p50 5.6 ms, p95 18.5 ms, max 84 ms; burners at nice 10 gave p50 1.0 ms, p95 3.2 ms, max 11 ms.

Other results on Bun 1.4.4:

- `keepAliveTimeout` is honoured and the connection closes about 1 s after it (1 s closes at 2.0 s, 65 s at 66.0 s), including a value set after `listen`. With `0`, the connection stayed open for the 200 s the probe waited.
- A connection left idle for 70 s, past the default 60 s `headersTimeout`, still serves a request, so `headersTimeout` needs no change.
- Partial headers and an unsent body stayed open for 12 s under a 3 s `headersTimeout` and a 3 s `requestTimeout`. Neither was enforced within that time.
- Slow responses of 15, 65, 125 and 310 s all reached the client as 200 through the proxy, so neither Bun's defaults nor a Serve-style transport cut off a slow backend.

Fix 2's cost, measured on a busy machine, so no reading is from a truly idle one: a fixed Bun job used the same CPU at both priorities (1.17 and 1.18 s) and took longer at nice 10 only by waiting (median wall 1.41 s and 1.84 s). `bun -e 0` start-up pinned to two cores: 40 ms with no burners; 92 ms against 16 nice-10 peers; 608 ms against 16 nice-0 burners. At nice 0 against those burners it took 60 ms.

## Constraints and rationale

- Do not retry invoke to hide these 502s. Terminal input sent twice types twice, and the terminal input sequencer's fence is deliberate.
- A 120 s keep-alive only removes this race while the proxy's idle timeout is shorter. A proxy that keeps idle connections longer than 120 s can still hit it.
- A backend that is down or restarting still gives a 502. Neither change affects that.
- An accept queue that overflows gives a 502 whatever the keep-alive is. That is a dial reset, not the idle-connection race.

## Open questions

- Why burners at nice 10 gave fewer 502s than no burners at all (2/5040 and 13/3360). The lab does not explain it, so treat that comparison as unexplained.

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (tasks 1, 2, 3, 5 and 6) moved there on 2026-11-10, and task 4 on 2026-11-11.
- `docs/todo/transcripts-and-observation/0052-remote-client-bandwidth.md`, "Live run through Tailscale Serve".
