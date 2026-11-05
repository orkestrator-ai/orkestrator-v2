# Gateway 502s under load: live evidence still needed

## Task analysis

Analysed 2026-11-05 against `main` at `a0a6d6206`. The lab results below date from 2026-11-04, against `main` at `96ee1eb3e`.

### Tasks

1. **Count Serve's proxy errors after this ships**: compare `http: proxy error` per day on each node before and after. Status: open.
2. **Read the same logs on rkmbp and the command node**: the user saw the 502s there. The command node (arktech-mini) has been read and does not fit the idle-connection race; rkmbp has not. Status: open.
3. **Run the race through real Tailscale Serve**: only a local Go reverse proxy has been exercised. Status: open.
4. **Measure nice 10 on macOS**: the macOS behaviour comes from reading XNU. Status: open.
5. **Decide whether container workloads need their own lever**: nice does not cross cgroups, so container agents still compete with the backend. Status: open.
6. **Name the sender of the command node's connection bursts**: hundreds of simultaneous requests reach arktech-mini's gateway through Serve. The gateway now logs `traffic.burst` with each burst's sources; the next burst on a build with it names the sender. Status: open.
7. **Stop one short stall from resetting a whole batch**: macOS resets every connection past a 128-deep accept queue. Status: open (depends on 6).

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

**Investigation.** rkmbp: not done. The command node, arktech-mini, read on 2026-11-05, does not fit the idle-connection race:

- It runs the standalone Tailscale app (1.102.4, then 1.104.5 after a reboot). Serve's errors are in the unified log under `io.tailscale.ipn.macsys.network-extension`: `log show --predicate 'eventMessage CONTAINS "proxy error" AND eventMessage CONTAINS "34121"'`. The searchable log starts at 2026-11-04 21:48 UTC, two hours after a backend that already had the 120 s keep-alive started (2.36.3-beta).
- The errors come in bursts of tens of thousands, not one or two a day: 02:36-02:54, 09:22-09:28 and 09:58:33-09:59:55 UTC on 2026-11-05, peaking at 13,009 in one minute. That last minute held 11,991 `dial tcp 127.0.0.1:34121: connect: connection reset by peer`, 939 `read: connection reset by peer`, 63 `write: broken pipe` and 2 `use of closed network connection`. A dial reset is a new connection refused, not a reused one going stale. The same backend process ran throughout.
- Resets arrive in batches that share one 10 ms timestamp, most often 126. In the 09:58-09:59 bursts, 57 batches of 120-135 held 7,233 of 17,361 errors.
- `kern.ipc.somaxconn` is 128. A throwaway Bun `node:http` server on an ephemeral loopback port, with its event loop blocked while a worker opened N simultaneous connections, reset nothing at 0-5 ms stalls and reset about N − 128 from 10 ms on (N = 250: 122, 107 and 122; N = 500: 372, 372 and 358). `netstat -s` reported `0 listen queue overflow` during the probe too, so that counter cannot rule this out. The backend's stall monitor reports only stalls of 1 s or more (`EVENT_LOOP_STALL_THRESHOLD_MS`), so 10-20 ms stalls never reach its log.
- 250 simultaneous connections is what Serve produces from one HTTP/2 client at its limit: Go's HTTP/2 server allows 250 concurrent streams (`defaultMaxStreams` in `x/net/http2`), Serve sets no other value, and its transport keeps only 2 idle upstream connections per host (`MaxIdleConnsPerHost` unset, `TS_DEBUG_SERVE_MAX_IDLE_CONNS_PER_HOST` overrides it). Up to 4,036 sockets sat in `TIME_WAIT` on the backend port, roughly 130 new connections a second. This fits but is not proven.
- Bursts recurred at 16:34-16:35 UTC with a load average near 5, so heavy load is not needed. Tailnet traffic to every active peer rose together at each batch, and mbp3 carried the most throughout.
- 13:33-13:52 UTC was a separate failure: 284 `connect: connection refused`. The backend's first start after the reboot timed out (`[desktop] startup.failed`, "Timed out waiting for the backend service") and the app stayed shut from 13:32 to 13:52.

**Decisions.**

- **Where to look on macOS?** For the standalone app, the unified log query above. Still unsettled for rkmbp until someone has looked.

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

### 6. Name the sender of the command node's connection bursts

**Problem.** Something sends hundreds of simultaneous requests to arktech-mini's gateway through Serve, repeatedly. Whatever sends them, every client whose request lands in an overflowing batch gets an empty 502, so the client that shows the banner need not be the sender.

**Context.** Serve terminates inbound TCP inside Tailscale's own network stack, so `netstat` does not show inbound connections by peer, and traffic counts by peer cannot separate one device from the rest. Serve sets `X-Forwarded-For` to the source tailnet address on every proxied request (`addProxyForwardedHeaders` in `ipn/ipnlocal/serve.go`). The gateway has no request logging and reads no forwarding or identity headers. The desktop client's invoke uses Electron main's undici `fetch` (HTTP/1.1, no per-origin connection cap); only browser clients and web views reach Serve over HTTP/2.

**Investigation.** Added the recommended summary: `apps/backend/src/gateway-traffic-summary.ts`, wired into the gateway's connection handler, request entry and invoke handler. Not yet observed on a real node: it reports only once arktech-mini runs a build that includes it. Reviewed the client retry and fan-out code: every stream reconnect loop has a backoff with a non-zero floor that a 502 cannot reset, so no loop spins on a failing request. Fan-outs without a concurrency cap include `apps/web/src/hooks/useEnvironments.ts` (one `getEnvironment` per unsettled environment), `apps/web/src/hooks/useTerminal.ts` (one reconcile per mounted terminal on connect) and `apps/web/src/lib/read-coordinator.ts` (re-reads every active key on reconnect). None is yet tied to a burst. SSH to mbp3, beelink, omarchy-hp and omarchy-gram failed from arktech-mini, so no client log was read.

**Decisions.**

- **How to attribute a burst?**
  - **Count requests by `X-Forwarded-For`, route and invoke command name in the gateway, and log a summary when a short window passes a threshold (recommended).**
    - Pros: durable, needs no root, and content-free if it records only addresses, route classes and command names.
    - Cons: needs a release before it observes anything.
  - **Capture loopback headers with root `tcpdump` during a burst, keeping only request lines, `X-Forwarded-For` and `"command"` names.**
    - Pros: answers now with no release.
    - Cons: needs the user's `sudo`, and a mistake in the filter would print request bodies or the bearer header.

### 7. Stop one short stall from resetting a whole batch

**Problem.** A 10 ms stall while about 250 connections arrive resets about 122 of them, and Serve turns each reset into an empty 502.

**Context.** macOS caps every accept queue at `kern.ipc.somaxconn` (128 here). A larger backlog passed to `listen` cannot exceed it. Go does not retry a failed POST, and invoke must not be retried (see Constraints).

**Investigation.** Not started; it depends on what task 6 finds.

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

- `docs/todo/transcripts-and-observation/0052-remote-client-bandwidth.md`, "Live run through Tailscale Serve".
