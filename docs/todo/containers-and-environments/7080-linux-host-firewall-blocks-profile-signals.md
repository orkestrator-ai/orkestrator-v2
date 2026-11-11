# A Linux host firewall keeps isolated profiles' container signals unconfirmed

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`, on beelink (Arch Linux,
kernel 7.1.8, rootful Docker Engine 29.9.2). First analysed at `e6c3da899`
while running [0020](0020-container-state-observation.md) tasks 2 and 3;
tasks 2 and 3 were done on 2026-11-06 (see Assumptions and decisions).

### Tasks

1. **Linux Engine real-stack signal run**: run `container-claude-terminal-signal.spec.ts` and `container-signal-profile-sample.ts` (with and without `--demote`) on a Linux Engine host where the profile's containers can reach its agent tools port. Status: blocked (waits on 7568: 7080 task 1).
2. **A firewall-friendly agent tools port for agent-test profiles**: let a Linux host with a default-deny input firewall admit every isolated profile with one rule. Status: done (`dev:test --agent-tools-port`, range 31500–31509).
3. **Show an unreachable doorbell in signal diagnostics**: tell "armed, route blocked" apart from "armed, waiting for a first ring". Status: done (`unconfirmed` signal state).

### 1. Linux Engine real-stack signal run

**Problem.** 0020's last qualification, the real-stack run on a Linux Engine host, could not produce signal evidence on beelink. Both container signals stayed `armed` with 0 rings for the whole session, so the spec fails before its first turn and the profile sample measures only the fallback cadence.

**Context.** The rings are HTTP POSTs from the container to the backend's agent tools server through the host-gateway alias (`host.docker.internal`, here `172.16.240.1`). beelink runs ufw with `DEFAULT_INPUT_POLICY="DROP"`. Its only allowances from Docker's ranges (`172.16.0.0/12`) are DNS to `172.17.0.1` and TCP 45507, the production installation's agent tools port. An installation's agent tools port is chosen once and kept (`AgentToolsServer.start`, `workflowResults.capabilityPort()` in `apps/backend/src/core/agent-tools.ts`), so the production backend always gets 45507 and an isolated profile gets its own random port (37525 for the `cso-linux` profile used here). The ticket for this run forbade changing the host firewall and required `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, which hides the "Docker containers can't reach Orkestrator" notice that would otherwise have named the problem.

**Investigation.** What was observed on 2026-11-06:
- The egress gateway's own firewall admits the route (`ORK_HOST_SERVICES` accepts `172.16.240.1` and `172.17.0.1` on TCP 37525), and the backend listens on `0.0.0.0:37525`. A `curl` from the runtime container to either address times out on connect, so the drop is the host's INPUT chain.
- The image's real `claude` 2.1.314 runs a full turn with no login against `e2e/agent-testing/container-fake-claude-api.ts` on the container's loopback, and its UserPromptSubmit and Stop hooks write the state file. Only the ring is lost.
- `container-claude-terminal-signal.spec.ts` with `ORKESTRATOR_AGENT_TEST_FAKE_CLAUDE_API=1` reaches its "signal confirmed" precondition and now fails there with the unreachable route named (see 0020's evidence). With that precondition relaxed in a local, uncommitted run, both turns met both budgets on the 1 s fallback poll, and the spec then failed on its ring assertion (0 rings), as it should.
- 2026-11-06, 0049 (retired 2026-11-11) task 9: the same route also carries the Orkestrator agent MCP a native Claude session in a container requires. On beelink the first turn of a container's native Claude tab ran, and every later turn was refused by the bridge with 409 "Claude required MCP server is not connected; retry the prompt" (a join checks the required server; a first launch does not). So a blocked agent-tools port also stops native Claude in containers after one turn, not only the signal rings.
- [container-qualification.md](../../development/container-qualification.md) records that ufw on this host once also admitted TCP 35723 from `172.16.0.0/12`. It no longer does: a listener on `0.0.0.0:35723` was not reachable from a container on the default bridge, and `/etc/ufw/user.rules` admits only 45507 and DNS from Docker's ranges.

Since task 2, the host change this run needs is one ufw rule admitting TCP from Docker's `172.16.0.0/12` pools to the documented agent-test range 31500–31509 (the command and its undo are in [agent-testing.md](../../development/agent-testing.md#containers-behind-a-host-firewall---agent-tools-port)). Adding it on beelink, or naming a Linux Engine host with no blocking input firewall, is the user's step and moved to the [manual-test checklist](../manual-test/7568-manual-test-checklist.md) (7080 task 1). With it in place, start the profile with `--agent-tools-port 31500` (any free port in the range), confirm `get_recurring_work_diagnostics` reports both signals `confirmed` rather than `unconfirmed`, and run the spec and the sample.

A real run needs, on a Linux Engine host: this checkout and its dev image (`mise run docker:build:dev`); a profile started with `--fixture --fixture-environments local,container` and either `--no-agent-credentials --agent-platforms claude` (fake API) or `--credential-source claude --agent-platforms claude` (a real login, billed turns); and a host firewall that admits TCP from Docker's ranges to the profile's agent tools port. On a host with exhausted Docker address pools, put `apps/desktop/scripts/dev/docker-qualification-bin` first on `PATH`, as the isolated runner does.

**Decisions.**

- **Which model backend counts as the Linux evidence?**
  - **The fake Messages API (recommended).**
    - Pros: no login and no cost, so it can run on any host and be repeated; the CLI, its hooks, the ring, the backend and the sidebar are all real, which is everything the Linux run exists to prove (the model is not platform-specific).
    - Cons: a Claude Code release that changes how it talks to the API can break the fixture without breaking real use.
  - **A real Claude login, as on Docker Desktop.**
    - Pros: like-for-like with the Desktop evidence.
    - Cons: each run spends subscription usage and needs a login staged into an isolated profile.
- **Where to run it?**
  - **beelink, after the user adds one ufw rule for the profile's port, or after task 2 (recommended).**
    - Pros: the host is otherwise ready (dev image built, profile works with the `/29` shim).
    - Cons: a firewall rule is a host change only the user may make.
  - **A host with no input firewall (a GitHub runner with Xvfb or headless Chromium).**
    - Pros: no host change; repeatable in CI.
    - Cons: does not show the firewalled-desktop case, which is the one a Linux user is likely to have.

### 2. A firewall-friendly agent tools port for agent-test profiles

**Problem.** A Linux user who allows Orkestrator through a default-deny firewall allows one port. Every isolated profile picks another random port, so agent-test containers on that host can never reach their backend: no signal rings, and no Orkestrator Agent MCP from inside the container.

**Context.** The port is sticky per installation through the workflow-result capability record, and falls back to a random port on `EADDRINUSE`. `dev:test` has no option for it.

**Investigation.** Not started beyond reading `AgentToolsServer.start`. The production port must never be bound by a profile (repository rule for 34121/34122; 45507 is likewise the user's running installation).

**Decisions.**

- **How should a profile get an admissible port?**
  - **A `dev:test --agent-tools-port <n>` flag recorded in the profile, so one firewall rule for a small fixed range covers every profile (recommended).**
    - Pros: explicit; one host rule, made once by the user; no product change outside agent-test.
    - Cons: a new flag; two profiles given the same port collide (the existing `EADDRINUSE` fallback then hides it, so the flag should refuse instead).
  - **Document a per-profile ufw rule and keep random ports.**
    - Pros: no code.
    - Cons: one host firewall change per profile, which agents may not make.

### 3. Show an unreachable doorbell in signal diagnostics

**Problem.** In `get_recurring_work_diagnostics`, a container whose rings can never arrive shows as `armed` with `rings: 0`, the same as a healthy container that has not rung yet.

**Context.** The install script's probe ring is fire-and-forget: `orkestrator-state-signal` backgrounds its `curl` so a hook never waits on the network (`docker/orkestrator-state-signal.sh`, `INSTALL_SCRIPT` in `apps/backend/src/core/claude-state-signal.ts`). The backend therefore cannot tell from the install whether the probe reached it. The container keeps the correct fallback cadence either way.

**Investigation.** Observed on beelink: 0 rings and `armed` for both signals for over 15 minutes, while the backend correctly ran the 1 s Claude poll with a terminal open and the fallback scan cadence for the worktree.

**Decisions.**

- **Report it, and how?**
  - **Count lineages that stay `armed` past the retry window with no ring as `unconfirmed` in the diagnostics, with no install change (recommended).**
    - Pros: content-free; no extra exec; an operator sees a route problem at a glance.
    - Cons: still cannot say why (firewall, proxy, DNS).
  - **Make the install's probe ring synchronous and report curl's result.**
    - Pros: names the failure at install time.
    - Cons: adds up to the connect timeout to every install exec; the hook path must stay non-blocking, so the script needs a separate synchronous mode.

## Assumptions and decisions

### Task 2: the flag and where it is enforced

`dev:test --agent-tools-port <n>` (the recommended option) is parsed by the
launcher, recorded as `agentToolsPort` in the profile's `profile.json`, and
handed by Electron to the backend as `--agent-tools-port`, which
`AgentToolsServer.start(port)` already treats as exact: a busy explicit port
fails the bind instead of falling back. The launcher also binds the port once
on all interfaces before writing the profile or starting anything, so a busy
port is refused with its number named and is never recorded. A port taken
between that check and the backend's bind still fails the start, in the
backend. 34121, 34122 and 45507 are refused, both by the flag and when a
`profile.json` is read, as is anything below 1024 or a non-agent-test profile
carrying the field. The one-shot browser runner forwards the flag.

### Task 2: the recorded port is kept on restart

A restart without the flag keeps the recorded port (a new flag replaces it,
`dev:reset` forgets it). The backend already prefers its data directory's
recorded port, but silently takes a random one when it is busy, which would
move a profile outside the firewall rule without saying so; keeping the port
in the profile turns that into a refusal. The alternative, a flag that applies
to one start only, would make every restart repeat it.

### Task 2: the documented range is 31500–31509

Ten ports, below Linux's ephemeral range (32768–60999) and macOS's
(49152–65535), so an outgoing connection or another random listener never
lands on one. The range is advisory: the flag accepts any unreserved port from
1024, so a host with a different rule can still be served.

### Task 2: no firewall change

The ufw rule (in agent-testing.md and the manual-test checklist) is written down for the user and was not run. beelink's
`/etc/ufw/user.rules` still admits only DNS and TCP 45507 from Docker's
ranges.

### Task 3: `unconfirmed` is a state, not a separate counter

All three signal sources (`claude-state-signal`, `container-worktree-signal`,
`tmux-hook-signal`) record when a lineage's install first finished with no
ring since, and report it `unconfirmed` instead of `armed` once it has waited
their whole retry window (5 min). A re-arm on the window keeps the time, a
ring (confirmation) or any demotion clears it. Making it a seventh state keeps
the states summing to `containers`; a separate count of a subset of `armed`
would have been additive but easy to misread. The install script is
unchanged; it still cannot say why a ring was lost.

### Evidence, 2026-11-06

- Focused tests: the new `apps/desktop/scripts/dev/agent-tools-port.test.ts`,
  `isolated-browser.test.ts`, `runtime-profile.test.ts`, `arguments.test.ts`,
  `lifecycle.test.ts`, `profile-io.test.ts`, the backend `options.test.ts`, and
  the three signal sources' tests with an `unconfirmed` case each.
- A throwaway headless `dev:test` profile (`atp-7080`, no credentials, Claude
  toolchain only, no container fixture) started with `--agent-tools-port
  31500`: its backend (the PID in its status manifest) listened on
  `0.0.0.0:31500` and `profile.json` held `"agentToolsPort": 31500`. A second
  profile asking for 31500 at the same time stopped with
  "--agent-tools-port 31500 is already in use" and wrote no `profile.json`;
  `--agent-tools-port 45507` was refused as reserved. Both profiles were
  stopped and removed.
- Not observed live: a container lineage reaching `unconfirmed` (it needs a
  container fixture and five minutes behind the firewall); unit tests cover
  it.

## Related

- [0020-container-state-observation.md](0020-container-state-observation.md) (the signals and the run this file continues).
- To-do 0241 (retired 2026-11-10): why this host's Docker address pools were exhausted; see [disk usage](../../development/disk-usage.md#what-you-clean-yourself).
- 7500 (retired 2026-11-11; `git show 498b68766:docs/todo/containers-and-environments/7500-agent-tools-port-auto-choice.md`): `--agent-tools-port auto`, which takes a free port in the range for concurrent profiles and is what the one-shot Docker runner's profiles use.
- [agent-testing.md](../../development/agent-testing.md#containers-behind-a-host-firewall---agent-tools-port) (the flag, the range and the rule).
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 1: adding the ufw rule on beelink or naming an unfirewalled Linux Engine host) moved there on 2026-11-10.
