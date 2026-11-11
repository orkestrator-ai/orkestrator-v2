# Claude's Linux sandbox fails every command under Ubuntu's AppArmor bwrap profile

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`; task 4 re-analysed and
run 2026-11-10 against `main` at `c98b20e6f`; tasks 1, 3 and 5 re-analysed
2026-11-11 against `main` at `498b68766`.

### Tasks

1. **Code items 1-3 (probe, user guidance, interactive refusal)**: the nested-namespace probe, the reason naming the remedy, and the bridge's up-front refusal. Status: done.
2. **Paired AppArmor CI qualification**: restricted and remediated phases on an Ubuntu 26.04 runner. Status: done.
3. **Stock AppArmor desktops, live**: Ubuntu 24.04's probe and CLI answer, with and without the profile change, from a CI job on `ubuntu-24.04` (the recommended route below). Status: open (waits on the first run of the `Claude AppArmor qualification` workflow, added 2026-11-11, which records the answer). The graphical half (the picker reason and the Agent Info tier on a stock desktop) moved to 7568 on 2026-11-10.
4. **Other platforms**: Debian with AppArmor, Fedora (SELinux) and Docker containers, from "Needs verification". Status: done (Docker containers probed with `docker exec` in a real environment container on 2026-11-10: `missing-programs`, and the container's own bridge refuses a provider-sandbox prompt with 422; Debian and Fedora stay optional, best-effort entries in 0031 and do not gate this file, as decided below).
5. **CLI nested-namespace setting**: the open question, whether a newer CLI drops the nesting or offers a setting that avoids it. Status: deferred (re-checked on every Claude bump).

### 1. Code items 1-3

**Problem.** None left. The probe, reason and refusal are in place.

**Context.** Recorded in "Current state" and decisions D1-D5.

**Investigation.** Still accurate at HEAD (re-checked 2026-11-11; line numbers moved).
- `probeClaudeLinuxSandbox` and the cached `claudeLinuxSandboxStatus` are at `packages/protocol/src/node/claude-linux-sandbox.ts:160` and `:226`; the reasons start at `:167`.
- `claudeSandboxRefusal` is at `bridges/claude-bridge/src/services/claude-execution-sandbox.ts:147`. It is called from the prompt route (`bridges/claude-bridge/src/routes/session.ts:909`) and the query plan (`bridges/claude-bridge/src/services/session-manager-prompt-query.ts:129`).
- `claudeReadOnlySandbox` turns the sandbox off for `unavailable` (`bridges/claude-bridge/src/services/read-only-policy.ts:579` and `:584`).
- The pinned CLI is now 2.1.319 (`docker/Dockerfile:208`; SDK `0.3.319` in `bridges/claude-bridge/package.json:16`).

**Decisions.** None: done and proved by unit tests and CI. The only open choice, how to close the file, is under task 3.

### 2. Paired AppArmor CI qualification

**Problem.** None left.

**Context.** CI run 40259536593 (see the evidence section).

**Investigation.** Both phases are still wired into `.github/workflows/ci.yml:110` (restricted) and `:138` (remediated), with the profile removal at `:124`. The reports are committed under `docs/tests/claude-apparmor/40259536593/`.

**Decisions.** None: done. Because CI reruns the pair on every run, it stays the regression guard for the probe.

### 3. Stock AppArmor desktops, live

**Problem.** The AppArmor branch has run only on CI's Ubuntu 26.04 runner. Ubuntu 24.04's answer has never been observed, so a probe that answers `available` there while the CLI fails (or the reverse) would go unnoticed.

**Context.** `omarchy-hp` has no AppArmor (`/sys/kernel/security/lsm` lists `lockdown,capability,landlock,yama,bpf,ima,evm`) and must not be changed. The run is batched in 0031 ("Stock Linux desktops with AppArmor or SELinux"). The graphical half is in 7568.

**Investigation.** The CI pair already proves the backend tier the picker and Agent Info read ("This proves the authoritative backend tier"); the open question was only 24.04's probe and CLI answer. Done on 2026-11-11, short of the run itself:
- `.github/workflows/claude-apparmor-qualification.yml` runs on `ubuntu-24.04` weekly, on demand and on pull requests that change the probe, the qualification, the coordinator table, the Claude pin or the workflow. It downloads the pinned CLI, installs `bubblewrap` and `socat`, runs `conformance-apparmor-live.test.ts` in a new phase `stock` before any policy change, applies the same remediation as CI's test shard, runs phase `remediated`, and uploads both JSON reports as `claude-apparmor-ubuntu-2404-<run>-<attempt>`.
- Phase `stock` (`conformance-apparmor-live.test.ts`) requires no particular answer. It takes the probe's (`available`, `nested-refused` or `outer-refused`; anything else, such as missing programs, fails as a setup error) and then requires the backend tier, run in its own process, to agree with it, and the pinned CLI to behave as the probe predicts: a working sandbox writes, reads and refuses a checkout write under the coordinator policy; a refused one is `provider-configured`, rejected at `enforced`, its hook-only reads and refusals still work, and the real prompt route answers 422 without dispatch. The `apply-seccomp`/`setgroups` and read-only-host scenarios run only where the `bwrap-userns-restrict` profile is installed. The report now also records whether the profile is installed and the two AppArmor sysctls.
- Phase `restricted` (26.04) is unchanged in what it requires; the backend reason is now compared with the probe's stem as well as the profile name.
- Evidence on `omarchy-hp` (2026-11-11, kernel 7.2.8, bubblewrap 0.13.1, pinned CLI 2.1.319, the local scripted endpoint with fake credentials, from a temporary copy of the test without its Ubuntu and AppArmor checks): phase `stock` passed all three branches. Unmodified host: `available`, `enforced` at both safety levels, `default-sandbox-writes`, `coordinator-sandbox-reads` and `coordinator-sandbox-refuses` as expected. A PATH shim running `bwrap --disable-userns`: `nested-refused`, `provider-configured`, 9 hook-only scenarios and the 422. A PATH shim `bwrap` that always fails: `outer-refused`, the same 9 scenarios and the 422. The phase's selection logic has deterministic tests in the same file (`AppArmor phase expectations`), and `tests/unit/ci-workflows.test.ts` pins the workflow's runner, step order and pinned-CLI path.
- Not observed: the workflow has not run yet. Its first run (the pull request carrying it touches its own path) gives 24.04's answer.

**Decisions.**

- **Does the desktop run still gate this file?**
  - **Keep it, but narrow it to Ubuntu 24.04 plus one UI look at the picker and Agent Info (recommended).**
    - Pros: 24.04 is the most common LTS and the one real unknown; the UI look is small.
    - Cons: still needs hardware or a VM nobody has here.
  - **Close it on the CI evidence.**
    - Pros: the backend tier is proved and CI repeats it.
    - Cons: 24.04 is unproved; a probe that answers `available` there while the CLI fails would be missed.
- **Where can it run?**
  - **A disposable Ubuntu 24.04 desktop VM, or a second CI job on `ubuntu-24.04` for the probe and CLI half (recommended).**
    - Pros: a CI job needs no hardware and gives repeatable evidence for 24.04's probe answer.
    - Cons: CI gives no graphical check; the VM still needs someone to drive it.
    - Split on 2026-11-10: the CI job is this task; the graphical check on a
      stock desktop is in 7568.
  - **Wait for a contributor with a stock Ubuntu desktop.**
    - Pros: a real user setup.
    - Cons: no date; the file stays open indefinitely.
- **Which workflow carries the 24.04 job? (decided 2026-11-11, D7)**
  - **Its own workflow, path-filtered plus weekly and on demand (chosen).**
    - Pros: no extra job on every pull request; the weekly run catches runner-image changes; a Claude bump (`packages/toolchain/src/manifest.ts`) reruns it.
    - Cons: not a required check, so a red run needs someone to look at it.
  - **A second job in `ci.yml`.**
    - Pros: every pull request proves it.
    - Cons: one more runner per pull request on the Free plan's 20 concurrent jobs, for a secondary platform whose answer changes only with the runner image or the CLI.
- **What does the 24.04 phase require? (decided 2026-11-11, D8)**
  - **Agreement: whatever the probe answers, the tier and the CLI must match it (chosen).**
    - Pros: tests the actual risk (a probe that disagrees with the CLI) without guessing 24.04's answer; a runner-image change cannot make it fail for the wrong reason.
    - Cons: it would pass on any consistent answer, so the recorded report, not the green tick, is the evidence of what 24.04 does.
  - **Require `nested-user-namespace`, as on 26.04.**
    - Pros: a stronger claim.
    - Cons: 24.04 may refuse bubblewrap's own namespace instead (`kernel.apparmor_restrict_unprivileged_userns`), which would fail the job on a correct probe.

**Still to do.** When the workflow has run, record 24.04's `stock` answer here (the report's `expectation`, `probe`, `appArmorBwrapProfile` and `sysctls`), mark this task done and, with task 5 a bump-time check only, delete this file. If the run is red, read the report and the log: a disagreement between the probe and the CLI is a product bug in the probe.

### 4. Other platforms

**Problem.** Debian with AppArmor, Fedora (SELinux) and Docker containers had not been observed. Docker containers were on 2026-11-10 (below); Debian and Fedora still have not.

**Context.** Docker is a different case from the others. The image installs no `bubblewrap` or `socat` (no match in `docker/Dockerfile`), so a container probe answers `missing-programs`, and the bridge refuses provider-sandbox turns with that reason (the probe runs inside the container, D3).

**Investigation.** The container behaviour is fully determined by the code and the missing programs. It overlaps 0190, whose container read-only turns fail for the same reason. Debian enables AppArmor by default but does not ship Ubuntu's `bwrap-userns-restrict`; Fedora uses SELinux, which the probe does not name. Both are expected to answer `available` unless local policy differs.

Container run, 2026-11-10 on `beelink2` (Arch/Omarchy, kernel 7.2.15, x86_64). The image was built from this checkout (`docker/Dockerfile` at `c98b20e6f`, Debian 13 base, pinned CLI 2.1.319) inside a disposable rootless daemon (`mise run docker:disposable`, Docker Engine 29.9.2, builtin seccomp profile), because the host daemon was not open to this run and must not be changed. A throwaway `dev:test` profile (`--fixture --fixture-environments local,container --no-agent-credentials`, `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, the `docker-qualification-bin` shim on `PATH`) let the backend create the fixture's container environment itself: a restricted runtime joined to its egress gateway, user `node`, `--init`, `CAP_NET_RAW` dropped, no capability added, not privileged. Then, with `docker exec -u node` in that runtime:

- **The probe.** `command -v` found `unshare` but neither `bwrap` nor `socat`. `probeClaudeLinuxSandbox()` (the module copied into `/tmp`, the same code the bridge bundles) answered in 0.3 ms: `{"available":false,"failure":"missing-programs","reason":"… needs bubblewrap and socat on PATH, and bwrap and socat are missing. …"}`.
- **The bridge's refusal.** The container's own `/opt/claude-bridge/dist/index.js`, imported in process with a temporary HOME, a fixture key and no port bound, created a session with policy `sandbox: "provider"` (201) and answered its prompt 422 `{ "kind": "sandbox-unavailable" }` with that reason. The session stayed `idle` with no messages; a `sandbox: "container"` session was created normally as the control. Both were closed.

Two throwaway containers from the same image show what shipping the programs would change (outside the environment, with `bubblewrap` 0.12.0 and `socat` installed by `apt-get`, run as `node`, the runtime's `--init` and `--cap-drop NET_RAW`):

- With Docker's default seccomp profile the probe answers `user-namespace` ("No permissions to create a new namespace"), and the CLI's own availability check, `bwrap --unshare-user --dev-bind / / true`, fails the same way, so the CLI would refuse the turn itself.
- With `--security-opt seccomp=unconfined` the namespace is created, and bubblewrap then fails to mount `/proc` ("Operation not permitted") under Docker's masked `/proc`. Still `user-namespace`.

So adding the packages to the image would not give containers a working Claude sandbox without weakening the container's own seccomp and `/proc` settings; the container stays the sandbox (`sandbox: "container"`), and a session overridden to `provider` inside one is refused with a reason that names the cause. These two runs were under a rootless daemon; a rootful daemon applies the same default seccomp profile and masked paths, which is what refused here. Everything this run created (profile, containers, volumes, network, daemon, image) was removed with `dev:stop`, `dev:reset` and `docker:disposable stop`.

**Decisions.**

- **How are the containers verified?**
  - **One `docker exec` probe in a real environment, recorded here and reused by 0190 (recommended; done 2026-11-10).**
    - Pros: cheap; settles both files' container question at once.
    - Cons: needs a running container environment.
  - **Accept the code reading.**
    - Pros: no run.
    - Cons: 0190 explicitly asks for a real container, so it would stay open anyway.
- **Do Debian and Fedora stay in scope?**
  - **Keep them as optional, best-effort entries in 0031 and do not let them gate this file (recommended).**
    - Pros: neither ships the profile that caused this; they are secondary platforms.
    - Cons: an SELinux-specific failure would be found by a user first.
  - **Require both before closing.**
    - Pros: complete coverage.
    - Cons: no such hosts here; this blocks closure on low-risk runs.

### 5. CLI nested-namespace setting

**Problem.** It is unknown whether the CLI could avoid the nested namespace altogether.

**Context.** It is re-checked on every Claude bump (`docs/development/upgrade-agents.md:581`).

**Investigation.** The pinned SDK 0.3.309 still offers `allowNestedUserNamespaces` (`bridges/claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:9179`). Its doc says it "Removes code-execution isolation", so it cannot back `enforced`. Re-checked 2026-11-11 against SDK 0.3.319 (`sdk.d.ts:9382`): still there, and its doc now says it lets *sandboxed commands* create user namespaces of their own ("a nested bubblewrap, and `unshare`"), which reads as unrelated to the helper's own nesting. No setting that avoids the helper's nested namespace exists.

**Decisions.**

- **Is this kept as an open question?**
  - **Keep it as a bump-time check only and do not count it as outstanding work (recommended).**
    - Pros: already in the runbook; no action is possible until the CLI changes.
    - Cons: easy to forget if a bump skips the runbook.
  - **Test `allowNestedUserNamespaces` on the CI runner now.**
    - Pros: answers whether it avoids the helper's nesting.
    - Cons: even a yes cannot be used, because it drops isolation.

Found on 2026-10-25 by todo 0030's CI probes on GitHub's `ubuntu-latest`
runner, which is now Ubuntu 26.04 (kernel 7.0). The code items were done on
2026-10-26 against `main` at `93018933`. Paired Ubuntu runner qualification
passed on 2026-10-26; desktop and other-distribution qualification remains.

On that host, with `bwrap` and `socat` installed, the pinned Claude CLI
(2.1.309) starts its command sandbox, but every sandboxed command fails before
it runs:

```text
Exit code 1
apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller must provide CAP_SYS_ADMIN): Permission denied
```

Before the fix, Orkestrator still reported such a host as able to sandbox
Claude, so a Claude coordinator showed `enforced` and then could not run a
single reading command, and an interactive session with the provider sandbox
failed every Bash call.

## Current state

- **Cause, confirmed on CI.** The CLI runs each command under bubblewrap and
  then its `apply-seccomp` helper, which creates a user namespace nested inside
  bubblewrap's. Ubuntu's AppArmor package ships a `bwrap-userns-restrict`
  profile (`/etc/apparmor.d/bwrap-userns-restrict`, with `unpriv_bwrap`) that
  lets bubblewrap create its namespace but strips capabilities from anything
  nested in it. Probe run 40195484352 (2026-10-25):
  - `kernel.apparmor_restrict_unprivileged_userns=0`: still fails (that sysctl
    only covers the first namespace).
  - Also `kernel.apparmor_restrict_unprivileged_unconfined=0`: still fails.
  - Also unloading `bwrap-userns-restrict` and `unprivileged_userns` with
    `apparmor_parser --remove`: a nested `unshare --user --map-root-user`
    inside bubblewrap works, and all 8 cases of
    `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts`
    pass.
- **What the CLI runs (read from the 2.1.309 binary, 2026-10-26).** bubblewrap
  with `--new-session --die-with-parent --unshare-user --unshare-pid …
  --dev /dev --proc /proc`, then the embedded `apply-seccomp` helper (executed
  from `/proc/self/exe`), which calls `unshare(CLONE_NEWUSER)`, writes
  `setgroups`, `uid_map` and `gid_map`, then `unshare(CLONE_NEWPID|CLONE_NEWNS)`
  and mounts `/proc`. Its own availability check only runs
  `bwrap --unshare-user --dev-bind / / true` and looks for the programs.
- **The probe now runs what the CLI needs.** `probeClaudeLinuxSandbox` and the
  cached `claudeLinuxSandboxStatus` (`packages/protocol/src/node/claude-linux-sandbox.ts`)
  run `bwrap --new-session --die-with-parent --unshare-user --unshare-pid
  --ro-bind / / --dev /dev --proc /proc -- unshare --user --map-root-user
  --pid --mount --fork --mount-proc true`, and on failure `bwrap … -- true` to
  tell the stages apart. Failures: `missing-programs`, `probe-unavailable`
  (no `unshare`), `user-namespace`, `nested-user-namespace`; the reason names
  `bwrap-userns-restrict` when AppArmor is enabled and that profile is
  installed. Each run is bounded at 5 s; answers are reused for 5 minutes.
- **The coordinator table uses it.** `defaultCoordinatorHostCapabilities`
  (`apps/backend/src/core/coordinator-providers.ts`) reports
  `claudeSandbox: false` with the probe's reason on such a host, so Claude is
  `provider-configured` and the picker says why.
- **A coordinator qualified without the sandbox leaves it off.** With
  `ORKESTRATOR_COORDINATOR_COMMAND_SANDBOX=unavailable`, `claudeReadOnlySandbox`
  now sends `enabled: false` (`bridges/claude-bridge/src/services/read-only-policy.ts`).
  Before, it asked for the sandbox without requiring it, and the CLI, which
  checks only the programs, would have started it and failed every command.
- **A turn that requires the sandbox is refused up front.**
  `claudeSandboxRefusal` (`bridges/claude-bridge/src/services/claude-execution-sandbox.ts`)
  runs the same probe in the bridge, where the CLI runs, for a session whose
  policy sets `sandbox: "provider"` and for a coordinator launched as
  `required`. The prompt route answers 422 `{ kind: "sandbox-unavailable" }` before journaling; the query
  plan throws the same reason for any other path. The backend shows the
  bridge's reason as the prompt error (`http-bridge-provider.ts`).
- **CI now requires paired qualification.** Before removing either AppArmor
  profile, `.github/workflows/ci.yml` runs
  `conformance-apparmor-live.test.ts` with phase `restricted`: the real probe
  must refuse nesting, the backend must downgrade Claude, the pinned CLI must
  fail with `apply-seccomp`/`setgroups`, hook-only reads must work and writes
  must be refused, and the real provider prompt route must return 422 without
  dispatch. After the existing disposable-runner remediation, phase
  `remediated` requires `enforced`, sandboxed reads and write containment.
  Both JSON reports are uploaded as one `claude-apparmor-<run>-<attempt>`
  artifact. Missing dependencies or an unexpected outcome fail qualification;
  they are never accepted as equivalent evidence.
- **Durable docs:** "Claude's sandbox on Linux" in
  [`coordinator.md`](../../architecture/coordinator.md#claudes-sandbox-on-linux)
  (the probe, the refusal, how to allow nested namespaces and what each choice
  costs), the execution-policy section of
  [`agent-engines.md`](../../architecture/agent-engines.md#execution-policy),
  and a Claude-bump re-check in
  [`upgrade-agents.md`](../../development/upgrade-agents.md).
- **Verified on an AppArmor-restricted Ubuntu 26.04.1 CI host:** the paired
  run below demonstrates downgrade before remediation and enforcement after it.
- **Verified in a real container environment (2026-11-10):** the probe
  answers `missing-programs` and the container's bridge refuses a
  provider-sandbox prompt with 422 (task 4).
- **Ubuntu 24.04 has a CI job (2026-11-11):** the `Claude AppArmor
  qualification` workflow runs phase `stock` (the tier and the CLI must agree
  with whatever the probe answers) and then `remediated` on `ubuntu-24.04`.
  It has not run yet (task 3).
- **Not verified:** Ubuntu 24.04's answer (until that run), a stock Ubuntu
  24.04 or 26.04 desktop (7568), Debian with AppArmor and Fedora (SELinux).

## Outstanding work

### Code

1. [x] **Probe the nested namespace, not only the programs.** Done
   2026-10-26. The probe above, bounded (5 s per run, two runs at most) and
   cached per process (5-minute TTL). A failing host is `provider-configured`
   with a reason naming the cause. Evidence:
   - Unit tests with an injected runner for every outcome:
     `packages/protocol/src/node/claude-linux-sandbox.test.ts` (works;
     AppArmor-named nested refusal; nested refusal without AppArmor; outer
     refusal; missing programs; no `unshare`; bounded reason; cache window)
     and `apps/backend/src/core/coordinator-providers.test.ts` (an AppArmor
     host is `provider-configured` with `bwrap-userns-restrict` in the reason
     and unavailable at `enforced`; a working host stays `enforced`).
   - Live on `omarchy-hp` (Arch/Omarchy, kernel 7.2.8, bubblewrap 0.13.1, no
     AppArmor), from a temporary copy of this branch: the real probe answered
     `{"available":true}` in 5.1 ms, `defaultCoordinatorHostCapabilities()`
     gave `{"claudeSandbox":true}` and Claude qualified `enforced`. Staging the
     nested refusal with bubblewrap's own `--disable-userns` (no host policy
     change) gave `nested-user-namespace` with "a user namespace nested inside
     it is refused (unshare: unshare failed: No space left on device)". The
     protocol suite's two on-host tests run these on any Linux host with
     bubblewrap.
2. [x] **Tell the user what to do.** Done 2026-10-26. The reason names the
   profile and both remedies; `coordinator.md` ("Claude's sandbox on Linux")
   gives the two choices and their costs. Orkestrator does not ship a profile
   and never changes AppArmor policy (decision D2).
3. [x] **Interactive provider sandbox.** Done 2026-10-26: the bridge refuses
   the turn up front with the same reason (decision D3). Evidence:
   `claude-execution-sandbox.test.ts` (provider and coordinator policies,
   including a malformed launcher value; read-only review turns in an
   ordinary bridge never refused, see 0190; only Linux probed; no probe for a
   turn that does not need one), `routes/session.test.ts` ("a turn that
   requires a sandbox this host cannot run commands in": 422 with the reason,
   nothing claimed or sent; an unsandboxed session unaffected, and since 0190
   a read-only review turn accepted to run on the hook alone),
   `session-manager-sandbox-refusal.test.ts` (the query plan fails without
   starting a CLI) and `http-bridge-commands.test.ts` (the backend surfaces
   the bridge's reason without the HTTP prefix).

Also done while there (2026-10-26): `unavailable` leaves the coordinator's
sandbox off (decision D4), and the live suite gained
`unavailable-hook-reads`, which shows a reading command still runs in that
mode. All 9 cases of `conformance-coordinator-sandbox-live.test.ts` pass with
the pinned CLI 2.1.309 on macOS and on `omarchy-hp`.

### Qualification

- [x] **AppArmor-restricted Ubuntu runner, paired probe/CLI qualification.**
  Passed 2026-10-26 in [CI run 40259536593](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/40259536593/job/121368688956),
  before and after remediation on the same runner. See the evidence below.
- [x] **Docker containers.** Done 2026-11-10: `docker exec` in a real
  environment container answered `missing-programs`, and the container's own
  bridge refused a provider-sandbox prompt with 422 before journaling. With
  the packages added, Docker's default seccomp and masked `/proc` still refuse
  bubblewrap. See task 4.
- [ ] **Stock AppArmor Ubuntu 24.04, probe and CLI.** Run steps 1 and 3
  below in a CI job on `ubuntu-24.04`, paired like the 26.04 phases, and
  record 24.04's probe answer here. The job exists since 2026-11-11
  (`.github/workflows/claude-apparmor-qualification.yml`, phases `stock` and
  `remediated`); what is left is recording its first run's report. Step 2 (the picker and Agent Info on a
  stock desktop) moved to 7568 on 2026-11-10. `omarchy-hp` has no AppArmor
  (`/sys/kernel/security/lsm` lists none) and must not be changed. How:
  1. On the stock host, from a checkout of this branch,
     `bun test --cwd packages/protocol --preload ../../tests/setup-node.ts ./src/node/claude-linux-sandbox.test.ts`
     and a one-line script printing `probeClaudeLinuxSandbox()`: expect
     `nested-user-namespace` with `bwrap-userns-restrict` in the reason (if
     24.04 answers `available`, also run step 3 to check it really works).
  2. (Moved to 7568: the coordinator picker, a coordinator turn and an
     interactive provider-sandbox session on a stock desktop.)
  3. Apply the CI change (`.github/workflows/ci.yml`) or a local profile, wait
     5 minutes or restart, and expect `enforced`, the coordinator turn's
     `printf x > out.txt` refused under bubblewrap, and the live suite
     (`bun test --cwd bridges/claude-bridge ./src/conformance-coordinator-sandbox-live.test.ts --preload ../../tests/setup-node.ts --parallel=1`)
     passing. Restore the profile afterwards.
  Batched in
  [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

## Paired qualification evidence — 2026-10-26

[CI run 40259536593](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/40259536593/job/121368688956)
qualified commit `823d91677` (PR merge revision
`18811727e82822fe6ef1fc36a1164d23acb79716`) on Ubuntu 26.04.1 LTS,
kernel `7.0.0-1017-azure`, with pinned Claude CLI **2.1.309**. Both phases
passed on the same disposable runner. The test required AppArmor enabled and
the Ubuntu bwrap profile installed; no policy change preceded the first phase.
The second phase followed CI's existing two sysctl changes and removal of
`bwrap-userns-restrict` and `unprivileged_userns` from the loaded policy.

| Observation | Stock policy | After remediation |
| --- | --- | --- |
| Real namespace probe | `nested-user-namespace`, reason names `bwrap-userns-restrict` | `available: true` |
| Backend coordinator qualification | `provider-configured`; rejected at safety level `enforced` | `enforced`; accepted at both safety levels |
| Pinned CLI sandboxed read | Fails with `apply-seccomp`, `setgroups`, `Permission denied` | Reads fixture successfully |
| Coordinator with unavailable sandbox | Hook-only `cat` succeeds; quoted writing option refused | Not needed |
| Provider-sandbox prompt | Real HTTP route returns 422 `sandbox-unavailable`; no dispatch id, runtime or transcript message | Direct provider-sandbox write control succeeds |
| Coordinator sandbox without the hook | Read fails before execution | Read succeeds; write to checkout refused and no file created |

The complete machine reports are retained in
[restricted.json](../../tests/claude-apparmor/40259536593/restricted.json) and
[remediated.json](../../tests/claude-apparmor/40259536593/remediated.json),
mirroring CI artifact `claude-apparmor-40259536593-1`. Every CLI scenario made
two calls to the local scripted endpoint with fake credentials and a temporary
home; no external model service was used. Reports omit prompts and tool output.
This proves the authoritative backend tier used by the picker and Agent Info;
a graphical desktop inspection remains in the checklist above.

## Constraints and rationale

- Do not weaken the coordinator's sandbox to make it start: a coordinator at
  `enforced` must have containment that works, and one that cannot get it
  must say so (`provider-configured`), as todo 0026 decided for hosts missing
  `bwrap` or `socat`.
- The CI change is acceptable on a disposable runner only; it is not advice
  for a shared host.

## Assumptions and decisions

### D1. How and where to probe

- **Options.** (a) The todo's command, `bwrap --unshare-user … -- unshare
  --user --map-root-user true`. (b) The same, shaped like the CLI's own
  invocation (`--unshare-pid`, `--new-session`, `--die-with-parent`) and with
  the helper's later PID and mount namespaces and `/proc` mount
  (`--pid --mount --fork --mount-proc`). (c) Run the CLI's embedded
  `apply-seccomp` helper itself. (d) Nest bubblewrap inside bubblewrap.
- **Chosen:** (b), with a second `bwrap … -- true` only on failure, in a
  shared `packages/protocol/src/node/` module so the backend and the bridge
  ask the same question. Synchronous `spawnSync`, 5 s per run, results reused
  for 5 minutes.
- **Why.** (b) is (a), which CI showed separates the broken and fixed hosts,
  plus the remaining steps the helper performs, so a host that allows the
  nested user namespace but not its mount or `/proc` is caught too. (c)
  depends on undocumented CLI internals (`/proc/self/exe` dispatch, argument
  layout) that can change in any bump. (d) was never tested under AppArmor.
  Synchronous because the qualification table and the prompt route are
  synchronous; a working host answers in about 5 ms.
- **Pros.** One probe, one reason everywhere; the second run lets the reason
  name the right policy; a host whose policy is fixed is re-read within 5
  minutes without a restart.
- **Cons.** It models the CLI rather than running it, so a CLI change could
  make it stale (the Claude bump runbook now re-checks it). It needs `unshare`
  (util-linux or BusyBox); without it the host fails closed
  (`probe-unavailable`) even if the CLI would work. A pathological `bwrap`
  could block the backend for up to 10 s once per 5 minutes.

### D2. Whether Orkestrator ships an AppArmor profile

- **Options.** (a) Ship a profile and install it. (b) Ship a profile file for
  administrators to install. (c) Ship none; document the two remedies and
  their costs.
- **Chosen:** (c).
- **Why.** Installing policy needs root and changes a security mitigation for
  every program on the host, which an app must not do on its own. A shipped
  file would have to track Ubuntu's own profile across releases, and it is
  untested here: no AppArmor host was available to prove one.
- **Pros.** Nothing changes a user's security policy behind their back;
  the default is safe (`provider-configured`, which the default safety level
  admits). **Cons.** An Ubuntu user who wants `enforced` has to write or adapt
  a profile themselves.

### D3. The interactive provider sandbox on such a host

- **Options.** (a) Leave it: every Bash call fails. (b) The backend refuses
  the policy when the session is created. (c) The bridge refuses each turn
  that requires the sandbox, from its own probe, before anything is sent.
  (d) Quietly run without the sandbox.
- **Chosen:** (c), for provider-sandbox sessions and coordinators launched as
  `required` (any launcher value but `unavailable`); Linux only. Read-only
  review turns in an ordinary bridge (no launcher value) are left as they
  were and moved to
  [0190](0190-claude-read-only-turns-without-working-sandbox.md).
- **Why.** The bridge runs where the CLI runs, which for a container
  environment is inside the container, where the backend's host probe says
  nothing. (d) would silently drop a boundary the user asked for. Read-only
  review turns were left out on evidence: on `omarchy-hp` the pinned CLI
  refuses such a turn outright when bubblewrap is missing (0 model calls),
  but under the AppArmor profile it still runs Read and Grep, so refusing it
  there would turn a degraded Multi Review into a failed one; that is a
  product decision of its own.
- **Pros.** One clear error instead of a failure per command; works for host
  and container sessions; nothing is journaled for a refused prompt.
- **Cons.** The whole turn is refused, including tools that would not have
  needed the sandbox (Read, Grep). Read-only review turns on such a host
  failed each Bash call until 0190 (done 2026-10-28: they now run with the
  sandbox off and the hook as the boundary, and say so). Windows is not probed: its sandbox is
  behind a vendor flag and its behaviour is unverified, so it keeps today's
  behaviour. A refused session needs its policy changed to run.

### D4. `unavailable` leaves the coordinator's sandbox off

- **Options.** (a) Keep asking for the sandbox without requiring it. (b) Turn
  it off on Linux only. (c) Turn it off wherever the launcher says
  `unavailable`.
- **Chosen:** (c).
- **Why.** The CLI decides availability from the programs alone, so asking
  for a sandbox the probe found broken starts it and fails every command; the
  live suite's staged macOS case showed the same on Seatbelt. Where the
  sandbox is truly absent, asking changes nothing.
- **Pros.** A `provider-configured` Claude coordinator works on an AppArmor
  host, with the hook as the boundary the tier already promises (shown live:
  `unavailable-hook-reads`). **Cons.** If a later CLI turns on Windows'
  sandbox while Orkestrator still reports it unavailable, the coordinator
  would not pick it up opportunistically until the probe learns about it.

### D5. Test isolation

- **Chosen:** `tests/setup-node.ts` pins the probe's answer to `available`
  (`setClaudeLinuxSandboxStatusForTests`), and the probe's and refusal's own
  tests inject theirs. **Why:** many bridge suites run provider-sandbox and
  read-only turns against a mocked CLI, and a Linux developer host without
  bubblewrap would otherwise refuse them. **Cons:** a test that wants the real
  cached probe must clear the pin first (the protocol cache test does).

### D6. How the container probe was run (task 4, 2026-11-10)

- **Options.** (a) `docker run` the image by hand with the backend's flags.
  (b) Let a throwaway `dev:test` profile's backend create the fixture's
  container environment, then `docker exec` into it. (c) Accept the code
  reading.
- **Chosen:** (b), on an image built from this checkout inside a disposable
  rootless daemon, plus two throwaway containers with the packages installed.
- **Why.** (b) is the container a user's environment really is (the
  backend's own create arguments, egress gateway, user and capabilities),
  which (a) only imitates; (c) leaves 0190's request for a real container
  unmet. The host's Docker daemon was not available to this run and must not
  be changed, so the image was built in the disposable daemon. The extra
  containers answer the follow-up a reader would ask (would shipping
  bubblewrap fix it?) without touching the environment.
- **Pros.** Real evidence for the probe answer and the bridge's 422 in the
  production container; the seccomp and `/proc` layers are told apart.
- **Cons.** The daemon was rootless; the refusals come from Docker's default
  seccomp profile and masked paths, which a rootful daemon applies too, but a
  rootful run was not made. The image has to be built in the disposable
  daemon first, which is the slow part of the run.

### D7. Where the Ubuntu 24.04 job runs (task 3, 2026-11-11)

- **Options.** (a) A second job in `ci.yml`. (b) Its own workflow, run
  weekly, on demand and on pull requests that change its inputs.
- **Chosen:** (b), `.github/workflows/claude-apparmor-qualification.yml`.
- **Why.** CI already pays for the 26.04 pair on every run; 24.04's answer
  changes only with the runner image or the CLI, which the schedule and the
  `packages/toolchain/src/manifest.ts` path cover. Its concurrency follows
  `container-live-qualification.yml` (pull requests coalesce, other runs keep
  unique groups), and `tests/unit/ci-workflows.test.ts` holds it to the same
  draft and concurrency contracts.
- **Pros.** No per-PR cost. **Cons.** Not a required check.

### D8. What the 24.04 phase requires (task 3, 2026-11-11)

- **Options.** (a) The 26.04 expectation (`nested-user-namespace` and the
  profile). (b) Agreement: take the probe's answer and require the backend
  tier and the pinned CLI to match it, failing only on a setup error.
- **Chosen:** (b), as phase `stock`; `restricted` and `remediated` keep their
  fixed answers through the same selection function.
- **Why.** The risk task 3 names is disagreement, not a particular answer,
  and 24.04 may refuse bubblewrap's own namespace rather than the nested
  one. Shown on `omarchy-hp` for all three answers (task 3).
- **Pros.** Cannot fail on a correct probe. **Cons.** A green run alone does
  not say which answer 24.04 gave; the uploaded report does.

## Open questions

- Does a newer Claude CLI drop the nested namespace, or offer a setting that
  avoids it? Partly answered 2026-10-26 from the 2.1.309 SDK types:
  `sandbox.allowNestedUserNamespaces` exists but "removes code-execution
  isolation", and `enableWeakerNestedSandbox` only skips the fresh `/proc`
  mount, so neither can back an `enforced` coordinator. Whether
  `allowNestedUserNamespaces` even avoids the helper's own nesting is
  unverified (no AppArmor host); the 0.3.319 types (2026-11-11) describe it
  as letting sandboxed commands create their own namespaces, which suggests
  it does not. Re-checked on every Claude bump
  ([`upgrade-agents.md`](../../development/upgrade-agents.md)).

## Needs verification

- Ubuntu 24.04: the first run of the `Claude AppArmor qualification`
  workflow (see Qualification). Debian with AppArmor and Fedora (SELinux)
  are optional, best-effort runs batched in 0031 (task 4). Docker containers
  were verified on 2026-11-10.

## Related

- [0026-coordinator-read-only-adapters.md](../coordinator-and-multi-review/0026-coordinator-read-only-adapters.md):
  the Claude coordinator tier and its Linux item.
- [0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md):
  where this was found, the CI probe runs and the workflow change.
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md):
  where the stock-host run is batched.
- [0190-claude-read-only-turns-without-working-sandbox.md](0190-claude-read-only-turns-without-working-sandbox.md):
  read-only review turns on such hosts, split out of item 3. Its container
  question can reuse task 4's run.
- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md)
  task 9: the provider sandbox on a real CLI, Linux half run on a host where
  this probe answers `available`.
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the graphical desktop half of task 3) moved there on 2026-11-10.

## Replaces

Nothing.
