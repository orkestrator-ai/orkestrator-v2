# Gateway 502s under load: live evidence still needed

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3e`.

### Tasks

1. **Count Serve's proxy errors after this ships**: compare `http: proxy error` per day on each node before and after. Status: open.
2. **Read the same logs on rkmbp and the command node**: the user saw the 502s there; only beelink's logs have been read. Status: open.
3. **Run the race through real Tailscale Serve**: only a local Go reverse proxy has been exercised. Status: open.
4. **Measure nice 10 on macOS**: the macOS behaviour comes from reading XNU. Status: open.
5. **Decide whether container workloads need their own lever**: nice does not cross cgroups, so container agents still compete with the backend. Status: open.

### 1. Count Serve's proxy errors after this ships

**Problem.** The lab removes every stale-connection 502 it can produce, but nobody has yet seen the count fall on a real node.

**Context.** Go's reverse proxy logs each failed upstream attempt as `http: proxy error: <cause>`, and Serve sets no error handler, so each line is one empty-bodied 502 sent to a client. On Linux the lines are in `journalctl -u tailscaled`.

**Investigation.** Beelink's journal from 2026-10-30 23:14 to 2026-11-04 03:11 UTC holds six: four `read: connection reset by peer`, one `write: use of closed network connection`, one `EOF`. None is a dial failure or a timeout. The backend service stayed up from 2026-10-30 23:33 UTC throughout, and no kernel OOM message falls within 20 s of any of them.

**Decisions.**

- **What counts as success?**
  - **Those three causes fall to about zero on each node over several days of normal use (recommended).**
    - Pros: measures the real path and real traffic; costs no load and no configuration change.
    - Cons: slow; at beelink's rate of about 1.5 a day, a few days are needed to tell a real fall from chance.
  - **A synthetic run through Serve (task 3) alone.**
    - Pros: quick.
    - Cons: shows the mechanism, not that the user's 502s stopped.

### 2. Read the same logs on rkmbp and the command node

**Problem.** The reported 502s came while rkmbp and the command node were busy, and this work could not read either machine's logs.

**Context.** The causes in those logs separate the explanations directly. `read: connection reset by peer`, `EOF` and `use of closed network connection` fit this race. `dial tcp ... connection refused` means the backend was not listening, and no keep-alive setting helps that. Bodies that fail after headers show up as `ReverseProxy read error during body copy`, which is not a 502.

**Investigation.** Not done. It is read-only, and it is the fastest way to confirm or reject the conclusion for those machines.

**Decisions.**

- **Where to look on macOS?** Unsettled until someone has looked: it depends on how Tailscale is installed there (`log show` for the app, or `tailscaled.log` for the open-source daemon).

### 3. Run the race through real Tailscale Serve

**Problem.** Serve itself has not been exercised. The stand-in copies Serve's transport values but not its inbound TLS and HTTP/2, or its one shared connection pool.

**Context.** The stand-in copies `getTransport()` from Tailscale v1.104.2 `ipn/ipnlocal/serve.go`: 90 s `IdleConnTimeout`, no `ResponseHeaderTimeout`, and the default error handler. Adding a Serve handler is off limits on beelink, so this needs another node; `0052-remote-client-bandwidth.md`, "Live run through Tailscale Serve", has the setup.

**Investigation.** The check to run: start `sse-route-probe.ts serve` behind Serve from a build before this change and one after. From a second tailnet device, send `POST /__orkestrator/invoke` with idle gaps of about 6 s for the old build and 88 to 92 s for the new one. Count client 502s and the node's `http: proxy error` lines, with and without bounded CPU load. Expect a low rate: the lab's best aim gave about 1% of requests. Serve shares one pool, so run sequentially rather than in parallel lanes, and plan for hundreds of requests.

**Decisions.**

- **Is this run required before relying on the fix?**
  - **No: do tasks 1 and 2 first, and run this only if they disagree with the lab (recommended).**
    - Pros: those tasks cost nothing and answer the question on real traffic.
    - Cons: the Serve-specific differences stay unmeasured unless the results disagree.
  - **Yes: run it first.**
    - Pros: quick, direct proof through the real proxy.
    - Cons: needs a spare tailnet node and changes its Serve configuration.

### 4. Measure nice 10 on macOS

**Problem.** Fix 2's macOS behaviour is inferred from source, not measured.

**Context.** In XNU, nice sets task importance and a thread's base priority becomes 31 minus nice (`resetpriority`, `task_policy.c`). Threads with an explicit QoS class ignore it (`thread_recompute_priority`). `sched_convert_pri_to_bucket` keeps priority 21 in the default bucket; priority 20 and below drop to utility. Nothing in that path sets the throttling that `taskpolicy -b` does.

**Investigation.** Not run. On a Mac, compare a fixed CPU job at nice 0 and nice 10 on an idle machine, then gateway latency with `yes`-style load at nice 0 and nice 10, and record whether the job moves to efficiency cores (`powermetrics`).

**Decisions.**

- **What if nice 10 turns out to slow idle work on Apple Silicon?**
  - **Lower the value, keeping the same mechanism (recommended).**
    - Pros: one constant, `WORKLOAD_NICE`.
    - Cons: weaker protection for the backend under load.
  - **Skip lowering on macOS.**
    - Pros: no slowdown at all.
    - Cons: macOS loses the protection, and macOS is where the highest load was reported.

### 5. Decide whether container workloads need their own lever

**Problem.** Agents and builds in Docker containers are not lowered relative to the backend.

**Context.** On Linux, nice ranks tasks only inside one CPU cgroup. Containers sit under `system.slice`, while the backend's service sits under `user.slice`. The two slices have equal default weights, so under contention the backend's slice already keeps about half the CPU. `--cpu-shares` would only rank containers against each other inside `system.slice`. On macOS, containers run inside the Docker Desktop VM, whose priority is not set per container.

**Investigation.** From reading cgroup rules; not measured. Beelink had no running containers when this was analysed, so its evidence says nothing about them. If rkmbp runs its work in containers, Fix 2 does little for it.

**Decisions.**

- **What to do about it?**
  - **Measure first, on a machine saturated by container work, and change nothing yet (recommended).**
    - Pros: on Linux the slice split may already be enough; avoids adding a setting without evidence.
    - Cons: a macOS host with busy containers stays unprotected for now.
  - **Give the backend's service unit a higher `CPUWeight` on Linux.**
    - Pros: works across cgroups and needs no privileges inside a user service, at least within `user.slice`.
    - Cons: does not help against `system.slice`, Linux only, and does not cover a backend started by Electron.

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

## Open questions

- Why burners at nice 10 gave fewer 502s than no burners at all (2/5040 and 13/3360). The lab does not explain it, so treat that comparison as unexplained.

## Related

- `docs/todo/transcripts-and-observation/0052-remote-client-bandwidth.md`, "Live run through Tailscale Serve".
