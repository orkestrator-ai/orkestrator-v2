# Container benchmarks in CI miss three regression targets, and nobody has recorded why

Checked against `main` at `863b5782` (2026-10-27).

The container benchmark (C28) in the "Container live qualification" workflow
reports 26 to 28 Docker CLI calls per fresh environment against a target of at
most 21, on both GitHub runner architectures. 0022 recorded 15 on 2026-10-25,
before the external egress gateway landed. On linux-x64 the 0109 PR also
pushed warm start to 2.14 s (target at most 2 s), and fresh-to-ready is 3.04 to
3.41 s (target at most 3 s). `container-qualification.md` says a miss is fixed
or its reason recorded before the change merges; neither happened for the
egress gateway (#1279) or 0109 (#1307). The Linux arm64 figures 0022 lists as
missing already exist as CI artefacts. Found in
[0022](0022-container-resource-budgets-and-performance.md)'s task analysis.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Attribute the extra Docker calls**: find which calls took a fresh environment from 15 to 26, and from 26 to 28. Status: open.
2. **Explain the start-time rise with 0109**: find what added 300 to 600 ms to warm start and fresh boot. Status: open.
3. **Fix or record each miss**: apply the merge-gate rule to the three misses, re-baselining only with a stated reason. Status: open (depends on 1 and 2).
4. **Record the CI numbers, arm64 included**: copy them into `container-qualification.md` before the artefacts expire. Status: open.
5. **Reference-host run at HEAD**: run the harness on the host the targets were set on. Status: open.

### 1. Attribute the extra Docker calls

**Problem.** Calls per fresh environment nearly doubled and the report cannot say where.

**Context.** The harness counts every `docker` invocation in the process across the storage, create and boot phases and reports only their sum (`apps/backend/tests/container-benchmarks.test.ts:56-63`, `:219`). The boot phase is `startRuntime` (`apps/backend/tests/container-live-start.ts:10-13`): `prepareEgressGatewayForStart`, then `docker start`.

**Investigation.** Confirmed from the downloaded reports (`gh run download`):

| Run | Head | linux-x64 calls (min / median) | linux-arm64 calls (min / median) |
| --- | --- | --- | --- |
| 40304582303, weekly `main` | `f1223e0b` | 25 / 26 | 26 / 26 |
| 40333566613, 0058 PR | `69857dac` | 26 / 28 | 26 / 26 |
| 40338400817, 0109 PR | `e8306626` | 28 / 28 | 28 / 28 |
| 40409285999, 0109 PR | `e53ea683` | 28 / 28 | 28 / 28 |

- The 15 in 0022 was measured on Docker Desktop arm64 on 2026-10-25, before the egress gateway (`c55807f9`, #1279, 2026-10-25 19:58 UTC). No CI figure exists from before the gateway, so 15 to 26 mixes a platform change with the gateway.
- A restricted runtime now has a second container: the gateway's create (`createEgressGateway`, `apps/backend/src/core/egress-gateway.ts:246-277`), and in `prepareEgressGatewayForStart` (`:354-400`) its lookup, inspection, start, firewall wait and a final inspect all count. This is the likely source of most of the jump, not yet counted call by call.
- The firewall wait polls every 250 ms and spends two calls per unfinished poll, `gatewayFirewallState` and `inspectGateway` (`waitForEgressGatewayFirewall`, `:304-334`). The count therefore depends on how long the gateway's firewall takes to apply: one more poll is exactly two more calls. That fits the 0058 x64 run moving between 26 and 28 before 0109, and 0109's steady 28.
- 0109 also added one `docker cp` per gateway create, `copyGithubRangesSeed` (`egress-gateway.ts:253`, `apps/backend/src/core/github-ranges-cache.ts:120-133`), when a GitHub ranges seed exists. Whether the benchmark's context has a seed is unconfirmed.
- Certainty: the totals are confirmed; the attribution is likely but unmeasured.

**Decisions.**

- **How to attribute the calls?**
  - **Report calls per phase, and per gateway versus runtime, in the benchmark JSON (recommended).**
    - Pros: every later run explains itself; the harness already wraps each phase in `timed`.
    - Cons: a report format change; a counted call list must stay content-free (verbs only, no arguments).
  - **Trace once with a `docker` shim that logs each verb.**
    - Pros: no harness change.
    - Cons: one-off evidence; the next regression needs the same work again.

### 2. Explain the start-time rise with 0109

**Problem.** Warm start on x64 went from 1.52 s to 2.14 s with 0109, over the 2 s target. Fresh-to-ready on x64 is over 3 s.

**Context.** 0022's analysis attributed the rise to `startDockerContainer`'s extra inspection and network check (`apps/backend/src/core/container-start.ts:185`).

**Investigation.** That attribution does not hold on the success path.
- `startDockerContainer` issues one `docker start` and returns (`container-start.ts:197-203`). It inspects only after an address-in-use failure (`:204-240`). In the benchmark only the gateway goes through it (`egress-gateway.ts:369`); the runtime gets a bare `docker start`.
- The rise is in the boot phase on both architectures: x64 `startToReady` 2.64 to 2.98 s and warm start 1.52 to 2.14 s; arm64 2.40 to 2.66 s and 1.63 to 1.90 s (weekly run against the two 0109 runs). Storage and create phases did not move.
- x64 fresh-to-ready was already 3.04 s on the weekly `main` run and 3.35 s on the 0058 run, so that miss predates 0109; 0109 took it to 3.40 to 3.41 s.
- A likely cause is the image, not the backend: `relay_staged_inputs` (`docker/network-policy-entrypoint.sh:165-196`) runs on every boot. The benchmark stages a small Claude home for every runtime (`container-benchmarks.test.ts:71`, `:103`). On a GitHub runner the host user is not uid 1000, so `node` cannot read the staged mount and the relay copies it on every start. On a uid-1000 host it only runs the readability checks. So the rise may be specific to hosts like CI. Unconfirmed.
- Certainty: the numbers are confirmed; the cause is a hypothesis.

**Decisions.**

- **How to find the cost?**
  - **Run the harness at `1aabf049` and its parent on the reference host (uid 1000) and compare with CI (recommended).**
    - Pros: separates the relay's copy (CI only) from anything every host pays; uses the existing harness.
    - Cons: needs a quiet window on a busy host.
  - **Time the entrypoint's steps inside the container.**
    - Pros: points at the exact step.
    - Cons: needs timing output in the image, which must stay content-free and bounded.

### 3. Fix or record each miss

**Problem.** Three targets are missed and the rule in `container-qualification.md` was not applied when the changes merged.

**Context.** The targets were set on Linux x86_64, 12 CPUs, Engine 29.7.2, no budget (`docs/development/container-qualification.md`, "Benchmarks"). CI runs 4-CPU runners on Engine 28.0.4 with the built-in default budget.

**Investigation.** Neither `container-qualification.md` nor 0109's file mentions the CI numbers. The weekly runs will keep reporting the misses.

**Decisions.**

- **What to do about the calls target?**
  - **Cut the calls that attribution shows are avoidable, then re-baseline the target to the remainder with the gateway's share stated (recommended).**
    - Pros: the gateway is a second container by design, so some rise is legitimate; a stated budget keeps later rises visible.
    - Cons: needs task 1 first.
  - **Keep 21 and treat every run as a miss until calls are cut to it.**
    - Pros: the strictest reading.
    - Cons: likely unreachable with a gateway, so the target stops meaning anything.
- **What to do about the start-time targets?**
  - **Keep them, and fix the cause if the reference host also misses; record "CI runner only: relay copy" if it does not (recommended).**
    - Pros: targets stay tied to the reference host they were set on.
    - Cons: CI keeps showing a red figure that has a recorded reason.
  - **Re-baseline the timings to CI.**
    - Pros: one repeatable host, run weekly.
    - Cons: runner hardware can change under the targets, and it would hide a real 0109 regression.

### 4. Record the CI numbers, arm64 included

**Problem.** 0022 says Linux arm64 has never been measured, but four CI runs measured it.

**Context.** The workflow uploads `container-benchmarks-linux-<arch>` with `retention-days: 30` (`.github/workflows/container-live-qualification.yml:174-184`), so the 2026-10-26 reports expire around 2026-11-25.

**Investigation.** Run 40409285999 (image `sha256:e12b0404d188…` arm64, `sha256:5cadbe5b0185…` x64; 4 CPUs, Engine 28.0.4, built-in default):

| Measure (target) | linux-arm64 | linux-x64 |
| --- | --- | --- |
| Fresh to ready (≤ 3 s) | 2.96 s | **3.40 s** |
| Docker calls per fresh environment (≤ 21) | **28** | **28** |
| Three concurrent, slowdown (≤ 1.5×) | 1.11× | 1.44× |
| Warm stop (≤ 1 s) | 0.10 s | 0.13 s |
| Warm start (≤ 2 s) | 1.90 s | **2.14 s** |
| 5,000-file copy (≤ 20 s) | 13.0 s | 14.6 s |
| Calls per minute, view open (≤ 36) | 24 | 24 |
| Followers after grace (0) | 0 | 0 |

**Decisions.**

- **Where to record them?**
  - **Copy the table into `container-qualification.md` with run IDs and image digests, and tick 0022's arm64 item (recommended).**
    - Pros: evidence survives the artefact expiry; closes 0022's item with numbers that exist.
    - Cons: the numbers come from a PR branch, not `main`.
  - **Wait for the next weekly run on `main`.**
    - Pros: measures merged code.
    - Cons: `main` now holds the same code, so it adds nothing but delay.

### 5. Reference-host run at HEAD

**Problem.** No run on the 12-CPU reference host exists since the gateway.

**Context.** Tasks 2 and 3 depend on it.

**Investigation.** The harness needs `RUN_LIVE_DOCKER_TESTS=1`, `RUN_CONTAINER_BENCHMARKS=1` and a workspace-specific image.

**Decisions.**

- **Which host?**
  - **omarchy-hp, the Linux amd64 reference, in a quiet window (recommended).**
    - Pros: the host the targets were set on.
    - Cons: it runs production work; the run must use its own image and labels and leave nothing behind.
  - **A clean cloud VM of the same size.**
    - Pros: no interference with production.
    - Cons: a new baseline host, so its figures are not directly comparable.

## Current state

- The benchmark asserts only that rebuilds succeed and no follower survives;
  the targets are compared by hand (`container-benchmarks.test.ts`,
  `container-qualification.md`, "Benchmarks").
- CI misses: Docker calls on both architectures (28 at HEAD's PR run); x64
  warm start (2.14 s) and x64 fresh-to-ready (3.40 s). arm64 meets every
  timing target.
- 0022's recorded figures (15 calls, Docker Desktop arm64, 2026-10-25) predate
  the egress gateway.
- 0022's attribution of the start rise to `container-start.ts` does not match
  its success path.

## Outstanding work

### Code

1. Add per-phase and per-container (gateway or runtime) call counts to the
   benchmark report, verbs only.
2. Cut avoidable calls found by item 1 (a candidate: the gateway firewall
   wait's two calls per 250 ms poll could be one, so the count stops
   tracking the gateway's boot time); then update the calls target in
   `container-qualification.md` with the reason.
3. If the reference host also shows the 0109 start rise, fix its cause; if
   it is the relay's copy on non-uid-1000 hosts, record that reason.

### Qualification

- The harness on omarchy-hp at HEAD and at `1aabf049`'s parent, with the
  results and reasons recorded in `container-qualification.md`.
- The CI table above copied into `container-qualification.md` before
  2026-11-25.

## Constraints and rationale

- The report must stay content-free: no commands, paths or arguments, only
  counts and durations.
- Never clear global Docker or cache state to manufacture a cold run.
- Benchmark runs use a workspace-specific image, never `orkestrator-v2:latest`.

## Open questions

- Should the benchmark step fail the workflow on a miss once the targets are
  re-baselined, instead of being compared by hand?

## Needs verification

- Whether the relay copies the staged Claude home on every CI boot (a boot
  log line or the relay directory's presence in a benchmark runtime would
  show it).

## Related

- [0022-container-resource-budgets-and-performance.md](0022-container-resource-budgets-and-performance.md)
  (the source; its arm64 item)
- [0109-rootless-linux-runtime-gaps.md](0109-rootless-linux-runtime-gaps.md) (staged-input relay, gateway seed copy)
- [0728-container-ci-c14-assumes-uid-1000.md](0728-container-ci-c14-assumes-uid-1000.md) (the same uid difference on CI)
- [Benchmark harness and regression targets](../../development/container-qualification.md#benchmarks)

## Replaces

Nothing; new on 2026-10-27, split from
[0022-container-resource-budgets-and-performance.md](0022-container-resource-budgets-and-performance.md)'s
task analysis.
