# Container benchmarks in CI miss three regression targets, and nobody has recorded why

Checked against `main` at `863b5782` (2026-10-27). Attribution, call cuts,
re-baseline and CI record done 2026-10-28 on `main` at `79f3bc97`; the
reference-host run remains.

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

1. **Attribute the extra Docker calls**: find which calls took a fresh environment from 15 to 26, and from 26 to 28. Status: done 2026-10-28 (the report now attributes every call by phase, container and verb).
2. **Explain the start-time rise with 0109**: find what added 300 to 600 ms to warm start and fresh boot. Status: done 2026-10-28 on Docker Desktop: readiness-poll quantisation, not the relay copy. Confirmation on the reference host is task 5.
3. **Fix or record each miss**: apply the merge-gate rule to the three misses, re-baselining only with a stated reason. Status: done 2026-10-28. Calls were cut by 1 + k per fresh start and the target re-baselined to ≤ 27 with the gateway's share stated. The start-time misses are recorded with their reason, and their fix is [0870](0870-container-start-poll-quantisation.md). The first CI run of this change still has to confirm the calls figure.
4. **Record the CI numbers, arm64 included**: copy them into `container-qualification.md` before the artefacts expire. Status: done 2026-10-28 (runs 40409285999 and 40746551838, both architectures).
5. **Reference-host run at HEAD**: run the harness on the host the targets were set on. Status: open (not reachable from the machine this work was done on).

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

**Result (2026-10-28).**

- The report now carries `freshRestricted.dockerCallsByPhase`,
  `dockerCallsByTarget` and `dockerCallBreakdown`, and the same for warm
  starts. The harness observes each call through
  `observeCommandInvocations` (`apps/backend/src/core/shell.ts`) and keeps
  only `<step> <container> <verb>` counts. It learns the runtime's and
  gateway's identities from the calls themselves, so attribution costs no
  call.
- Before the cuts, a steady fresh start cost 16 + 2k + R calls, where k is
  the number of unfinished firewall polls and R the number of readiness
  polls:
  - storage: 5 (two volume creates and inspects, one helper `run`);
  - create: 6 (network inspect and create, `ps`, gateway create, seed
    `cp`, runtime create);
  - gateway up: 5 + 2k (the runtime's network-mode and state inspects, the
    gateway's inspect and start, an exec and an inspect per unfinished
    poll, and the final exec);
  - `docker start`: 1;
  - readiness: R.
- 15 to 26 is the gateway's 6 + 2k: its create, the two runtime inspects,
  its inspect, its start and the polls.
- 26 to 28 is 0109's seed `cp` (the benchmark's data directory fetches a
  seed, so it is always copied) plus one more readiness poll (task 2).
- The first run of a process also pays six one-off capacity probes (`info`
  twice, `system df`, `context inspect`, and a probe `create` and `rm`),
  which is CI's maximum of 34 or 35.
- Measured on Docker Desktop, arm64, at `79f3bc97`. The evidence is in
  [container-qualification.md](../../development/container-qualification.md#benchmarks-on-linux-engine-ci-and-the-call-and-start-time-misses-2026-10-28).

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

**Result (2026-10-28).** The relay hypothesis does not hold, and neither does
the recommended way of testing it on the reference host, which was not
reachable (task 5). The cause was found on Docker Desktop instead.

- On the warm path the backend changed nothing in 0109. The benchmark's
  warm stop leaves the gateway running, so a warm start never reaches
  `startDockerContainer`. The rise is therefore in the image's boot.
- The relay's copy, timed alone in a throwaway container of the HEAD image
  with the benchmark's Claude home owned by uid 1001, costs 13 to 19 ms per
  boot (2 to 4 ms when there is nothing to copy). That is far too small for
  300 to 600 ms.
- With the same harness, an image built at 0109's parent (`9791a425`) and
  the HEAD image ran alternately, five runs in all. Fresh
  `startToReady.ready` fell into two clusters exactly one poll period apart:
  about 1.50 s (6 readiness polls) and about 1.82 s (7 polls). The parent's
  image mostly took 6 polls and HEAD's mostly 7.
- So 0109's per-boot cost is small, and it costs a whole poll period
  (250 ms sleep plus one exec, about 320 ms here) once it crosses a
  boundary. CI's 300 to 600 ms is one or two periods, and CI's 28 includes
  one more readiness exec.
- Warm-start medians moved 0.4 s between runs of the same image here, and
  CI's arm64 warm start moved from 1.90 s to 2.28 s between two runs with no
  boot-path change. So a single run cannot show a step this small.
- Certainty: the quantisation is measured. That the reference host shows
  the same effect is inferred.

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

**Result (2026-10-28).**

- **Calls.** Two cuts remove 1 + k calls from every fresh start, giving
  16 + k + R:
  - `createDockerContainer` records the runtime's network owner
    (`rememberNetworkOwner`, `container-network-owner.ts`), so the first
    start does not inspect its network mode.
  - `waitForEgressGatewayFirewall` inspects the gateway only when its exec
    fails: an exec that ran proves the gateway runs.

  A warm start whose running gateway already reported `applied` skips the
  second read. Docker Desktop went from a median of 31 (steady runs 28 to
  31) to 24 or 25 in all six runs after the change, and warm starts from 12
  calls to 10 or 11. The target is now ≤ 27, re-baselined as 21 for the
  runtime's own path plus the gateway's 6 fixed calls (create, seed copy,
  the runtime's state inspect, the gateway's inspect and start, and the
  first firewall read). The old code's 28 still misses it. CI's
  decomposition predicts 24 to 26 after the change; the first CI run of this
  change confirms it.
- **Start time.** The targets are kept. The x64 fresh-to-ready miss
  predates 0109, and the warm-start misses are a quantisation step on top
  of runner variance. Both reasons are recorded in `container-qualification.md`.
  Removing the quantisation needs a readiness change that the live
  readiness-fault suites must re-qualify, so it is
  [0870](0870-container-start-poll-quantisation.md).

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

**Result (2026-10-28).** Both 2026-10-26 runs' figures, and run 40746551838
(the 0728 PR, 2026-10-28), are in `container-qualification.md` with run IDs
and full image digests. In the later run arm64 also missed fresh to ready
(3.14 s) and warm start (2.28 s). 0022's arm64 item is closed with these
figures.

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
  the targets are still compared by hand. Every report now attributes its
  Docker calls (by phase, container and verb) and splits the boot into its
  gateway, `docker start` and readiness steps.
- Calls per fresh environment: 24 or 25 on Docker Desktop after this
  change, and 28 on CI before it. The target is ≤ 27 (21 for the runtime, 6
  for its gateway).
- Start time: the x64 fresh-to-ready and warm-start misses, and arm64's in
  run 40746551838, are recorded with their reason, readiness-poll
  quantisation on top of runner variance. The targets are unchanged.
- The CI figures for both architectures are in `container-qualification.md`.

## Outstanding work

### Code

None here. The poll-quantisation fix is
[0870](0870-container-start-poll-quantisation.md).

### Qualification

- The first CI run of this change: confirm calls ≤ 27 on both
  architectures, and read `startToReady.*` and `warmStopStart.startSteps` to
  see how many readiness polls CI's boot takes.
- Task 5: the harness on omarchy-hp at HEAD and with an image at
  `1aabf049`'s parent, results in `container-qualification.md`.

## Assumptions and decisions

### Task 1: report the attribution in the benchmark JSON

Took the recommended option.

- The harness observes calls through a new `observeCommandInvocations`
  hook in `shell.ts`. It reduces each call to `<step> <container> <verb>`
  at once and keeps no arguments, so the report stays content-free.
- Identities come from the calls themselves, so attributing costs no
  Docker call and does not change the totals.
- Only sequential runs are attributed; concurrent runs would see each
  other's calls.

### Task 1: split the boot into three timed steps

Not offered as an option.

- The harness now starts runtimes through its own `bootRuntime`, which does
  what `startRuntime` (`container-live-start.ts`) does and times the
  gateway, `docker start` and readiness steps separately.
- Why: without the split, a start-time rise cannot be placed between the
  gateway and the image's boot, which is what task 2 needed.

### Task 2: no reference-host run; Desktop A/B instead

The recommended option was a run on the reference host, which was not
reachable from this machine.

- I built an image at 0109's parent and compared it with HEAD's image on
  the same harness, alternating them on Docker Desktop. That separates the
  image's per-boot cost from the backend. It does not reproduce CI's
  relay copy, which I timed on its own instead.
- The relay finding contradicts the analysis's hypothesis: the copy costs
  about 15 ms. The quantisation explains the rise on a host with no relay
  at all.

### Task 3: calls target ≤ 27

Took the recommended option: cut, then re-baseline.

- The cuts are the firewall wait's inspect per poll (the candidate the
  file named), the first start's network-mode inspect (the create already
  knows the network), and a warm start's second firewall read.
- The new target is the old 21 for the runtime's own path plus the
  gateway's 6 fixed calls. A tighter number fitted to Desktop's 24 or 25
  would have tied the target to one loaded host's poll counts. With this
  one, the pre-change code's 28 is still a miss.

### Task 3: keep the start-time targets and record the reason

Took the recommended option.

- The reason recorded is different from the one the option expected. It is
  not "CI runner only: relay copy" but readiness-poll quantisation, which
  every host pays, on top of runner variance.
- The fix changes how readiness is observed, and the live readiness-fault
  suites (C09) must re-qualify that. This task's scope allowed only the
  benchmark harness to run live, so the fix moved to new todo 0870 instead
  of landing here.

### Task 3: the benchmark's warm stop stays a bare `docker stop`

Not offered as an option.

- The real stop path also stops the gateway (`stopRuntimeContainer`). The
  benchmark's warm stop does not, so its warm start never restarts the
  gateway.
- I left it as it is so that warm figures stay comparable with earlier
  reports, and documented it under "Benchmarks".

### Task 4: record two CI runs

Took the recommended option.

- I recorded run 40409285999 (the one the analysis cited) and the newer
  green run 40746551838 (the 0728 PR), with full image digests.
- Why: the second run shows the run-to-run variance that the start-time
  reason depends on.

### Task 5: left open

The reference host was not reachable from this machine, and the delegation
excluded it.

## Constraints and rationale

- The report must stay content-free: no commands, paths or arguments, only
  counts and durations.
- Never clear global Docker or cache state to manufacture a cold run.
- Benchmark runs use a workspace-specific image, never `orkestrator-v2:latest`.

## Open questions

- Should the benchmark step fail the workflow on a miss once the targets are
  re-baselined, instead of being compared by hand?

## Needs verification

- Whether the relay copies the staged Claude home on every CI boot. It no
  longer explains the rise (about 15 ms per boot), but a boot log line or
  the relay directory's presence in a benchmark runtime would show it.
- How many readiness polls a CI boot takes: the next report's
  `dockerCallBreakdown` (`boot.ready runtime exec`) shows it.

## Related

- [0022-container-resource-budgets-and-performance.md](0022-container-resource-budgets-and-performance.md)
  (the source; its arm64 item)
- [0109-rootless-linux-runtime-gaps.md](0109-rootless-linux-runtime-gaps.md) (staged-input relay, gateway seed copy)
- [0728-container-ci-c14-assumes-uid-1000.md](0728-container-ci-c14-assumes-uid-1000.md) (the same uid difference on CI)
- [0870-container-start-poll-quantisation.md](0870-container-start-poll-quantisation.md) (the start-time fix split from task 3)
- [Benchmark harness and regression targets](../../development/container-qualification.md#benchmarks)

## Replaces

Nothing; new on 2026-10-27, split from
[0022-container-resource-budgets-and-performance.md](0022-container-resource-budgets-and-performance.md)'s
task analysis.
