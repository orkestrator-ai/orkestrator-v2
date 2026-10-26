# Claude's Linux sandbox fails every command under Ubuntu's AppArmor bwrap profile

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
- **Not verified:** a stock Ubuntu 24.04 or 26.04 desktop, Debian with
  AppArmor, Fedora (SELinux) and Docker containers.

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
   ordinary bridge left alone, see 0190; only Linux probed; no probe for a
   turn that does not need one), `routes/session.test.ts` ("a turn that
   requires a sandbox this host cannot run commands in": 422 with the reason,
   nothing claimed or sent; an unsandboxed session and a read-only review
   turn unaffected),
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
- [ ] **Stock AppArmor desktops, live.** Run the coordinator sandbox
  qualification on a stock Ubuntu 24.04 host and a stock 26.04 desktop, with
  and without the profile change, and record the tier Agent Info shows. Not
  run on a desktop: no such desktop is available here, and `omarchy-hp` has no
  AppArmor
  (`/sys/kernel/security/lsm` lists none) and must not be changed. How:
  1. On the stock host, from a checkout of this branch,
     `bun test --cwd packages/protocol --preload ../../tests/setup-node.ts ./src/node/claude-linux-sandbox.test.ts`
     and a one-line script printing `probeClaudeLinuxSandbox()`: expect
     `nested-user-namespace` with `bwrap-userns-restrict` in the reason (if
     24.04 answers `available`, also run step 3 to check it really works).
  2. Start Orkestrator there and open the coordinator picker: Claude shows
     `provider-configured` with that reason; a coordinator turn runs
     `cat`/`rg` successfully with the hook as boundary. An interactive Claude
     session with **Settings → Execution policy** sandbox `provider` fails its
     first prompt with the same reason.
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
  still fail each Bash call until 0190 is done. Windows is not probed: its sandbox is
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

## Open questions

- Does a newer Claude CLI drop the nested namespace, or offer a setting that
  avoids it? Partly answered 2026-10-26 from the 2.1.309 SDK types:
  `sandbox.allowNestedUserNamespaces` exists but "removes code-execution
  isolation", and `enableWeakerNestedSandbox` only skips the fresh `/proc`
  mount, so neither can back an `enforced` coordinator. Whether
  `allowNestedUserNamespaces` even avoids the helper's own nesting is
  unverified (no AppArmor host). Re-checked on every Claude bump
  ([`upgrade-agents.md`](../../development/upgrade-agents.md)).

## Needs verification

- Ubuntu 24.04, Debian with AppArmor, Fedora (SELinux) and Docker containers
  (see Qualification).

## Related

- [0026-coordinator-read-only-adapters.md](../coordinator-and-multi-review/0026-coordinator-read-only-adapters.md):
  the Claude coordinator tier and its Linux item.
- [0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md):
  where this was found, the CI probe runs and the workflow change.
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md):
  where the stock-host run is batched.
- [0190-claude-read-only-turns-without-working-sandbox.md](0190-claude-read-only-turns-without-working-sandbox.md):
  read-only review turns on such hosts, split out of item 3.

## Replaces

Nothing.
