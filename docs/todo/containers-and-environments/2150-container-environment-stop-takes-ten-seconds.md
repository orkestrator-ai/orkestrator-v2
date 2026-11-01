# Stopping a container environment takes about 10 seconds

Checked against `main` at `93b99bfb` (2026-11-01).

[0022](0022-container-resource-budgets-and-performance.md)'s
multi-environment UI probe stopped and started an idle fixture container
environment 9 times on 2026-11-01. Each `stop_environment` took 10.5–11.6 s,
with or without load in other containers. Each `start_environment` took
3.9–5.9 s. The benchmark's warm stop, a bare `docker stop` of the runtime,
measured 0.10–0.59 s (0022, 0729). So the user-facing stop costs about 10 s
more than the benchmark reports.

## Task analysis

Analysed 2026-11-01 against `main` at `93b99bfb`.

### Tasks

1. **Attribute the 10 seconds**: find which step of `stop_environment` waits. Status: open.
2. **Fix it, or record why it must wait**: then make the benchmark measure what a user waits for. Status: open (depends on 1).

### 1. Attribute the 10 seconds

**Problem.** A stop that takes about 10 s looks like Docker's default stop
grace (`docker stop` sends SIGTERM, waits 10 s, then sends SIGKILL). If so,
something in the runtime ignores SIGTERM.

**Context.** `stopRuntimeContainer` (`apps/backend/src/core/egress-gateway.ts`)
runs `docker stop <runtime>` with no `-t`, then stops the egress gateway.
The runtime's PID 1 chain is `docker-init` → `sudo` →
`network-policy-entrypoint.sh` → `zsh` (`docker/Dockerfile`: `ENTRYPOINT` and
`CMD ["/bin/zsh"]`, `--init`). Its `StopTimeout` is unset, so the default
10 s applies; the gateway's is 5 s.

**Investigation.** Not yet done. The 10 s is measured from the page through
the gateway (`e2e/perf/multi-environment-ui-perf.ts`, host load average about
60 on 16 CPUs). That includes everything `stopEnvironmentTask`
(`apps/backend/src/core/commands-environment.ts`) does before
and after Docker: session drain, status writes and the gateway stop. The
SIGTERM explanation is a hypothesis: it fits the 10 s floor but is not
verified. The benchmark's stop is 0.1 s, so either the benchmark container
handles SIGTERM differently (no fixture workspace, no setup terminal), or the
time is spent outside `docker stop`.

**Decisions.**

- **How to attribute it?**
  - **Time each step of `stopEnvironmentTask` in one real-stack stop, and time `docker stop -t 0` against `docker stop` on an owned fixture container (recommended).**
    - Pros: tells Docker's grace apart from backend waits in one pass.
    - Cons: needs a disposable profile with a container fixture.
  - **Read the code only.**
    - Pros: cheap.
    - Cons: the PID 1 chain's signal handling depends on the image at runtime.

### 2. Fix it, or record why it must wait

**Problem.** If it is the grace period, every stop, rebuild and app shutdown
pays it per environment.

**Context.** The benchmark target "Warm stop ≤ 1 s"
([container-qualification.md](../../development/container-qualification.md#benchmarks))
times a bare `docker stop`, so it does not see this.

**Decisions.**

- **What to change if SIGTERM is ignored?**
  - **Make PID 1's chain exit on SIGTERM (for example `exec` the shell, or trap and forward in the entrypoint), and keep Docker's grace for real work (recommended).**
    - Pros: fast stops with a clean shutdown kept.
    - Cons: needs an image change and the C-series lifecycle qualification again.
  - **Pass a short `-t` to `docker stop`.**
    - Pros: one-line change.
    - Cons: kills processes that would have exited cleanly, for example an agent flushing state.
- **Benchmark?**
  - **Time `stop_environment` through the backend as well (recommended).**
    - Pros: measures what users wait for.
    - Cons: one more benchmark field and target.
