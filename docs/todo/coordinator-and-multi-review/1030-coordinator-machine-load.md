# Coordinators see each machine's load and OS

## Task analysis

Analysed 2026-10-31 against `main` at `931e55417`. Tasks 3 and 4 rechecked
2026-11-01 against `main` at `93b99bfba`: both problems were still as described.

### Tasks

1. **Rolling sampler, three windows, machine facts, `list_nodes`, coordinator guidance**: built. Status: done (2026-10-31).
2. **Live check across two real machines**: `list_nodes` on a real command node with a real leaf, including a leaf on an older release. Status: open.
3. **Native Linux and Windows check**: real OS strings and readings on those platforms. Status: Linux done (2026-11-01); Windows open, as it cannot be run here.
4. **Older-node detection elsewhere matches the wrong wording**: two existing checks look for `Unknown command:`, while a real backend answers `Unknown backend command:`. Status: done (2026-11-01).
5. **Keep history across a backend restart**: decide once coordinators are seen using the 24-hour figure. Status: open (deferred).
6. **Retire the older-node path**: remove it when the support window allows. Status: open.

### 1. Rolling sampler, three windows, machine facts, `list_nodes`, coordinator guidance

**Problem.** A coordinator picked a node knowing nothing about how busy it was or what it ran. `list_nodes` gave only id, name, availability, connection state, mode and whether the node had the project.

**Context.** The behaviour and its reasons are in [coordinator.md](../../architecture/coordinator.md#choosing-a-machine); cadence and cost are row B29 of [recurring-work.md](../../architecture/recurring-work.md). The code is `apps/backend/src/core/machine-load.ts`, `control-mcp-machine-load.ts` and `packages/protocol/src/machine-load.ts`.

**Investigation.** See [Assumptions and decisions](#assumptions-and-decisions).

**Decisions.** See [Assumptions and decisions](#assumptions-and-decisions).

### 2. Live check across two real machines

**Problem.** The node path is covered by a real Control MCP call with a fake remote node behind `invoke_on_node`, and the routing rules by unit tests. No real node link has carried `get_machine_load`, and no real older leaf has answered it.

**Context.** `readNodeMachineLoad` asks through `invoke_on_node` with a 2 s limit. The older-node branch relies on the wire wording `Unknown backend command: get_machine_load` (`OrkestratorBackend.invoke`, passed on by `gateway-handlers.ts`), read from the code rather than seen over a real link.

**Investigation.** Not run: it needs a second machine or a second backend attached as a leaf. The figure a leaf reports is its own, so clock differences between machines do not matter; coverage and age are durations.

**Decisions.**
- **How to run it?**
  - **Two disposable `dev:test` profiles attached as command node and leaf, one built from an older release (recommended).**
    - Pros: free, and exercises the real link and the real older-node answer.
    - Cons: both are on one host, so both report the same OS.
  - **A real command node with a real Linux leaf.**
    - Pros: also answers task 3 for Linux.
    - Cons: touches a machine that may be doing real work, so it needs the user's go-ahead.

### 3. Native Linux and Windows check

**Problem.** Only macOS was read on real hardware. On Linux, beelink's whole `PRETTY_NAME` is `Omarchy`, so its OS read as `Omarchy`, with no version and nothing to say it is an Arch derivative.

**Context.** On Linux the name comes from `/etc/os-release` and the figures from `os.cpus()` and `os.freemem()`. On Windows the name comes from `os.version()`.

**Investigation.** A throwaway `oven/bun:1.4.4` container on a Mac showed `os.freemem()` equal to `MemAvailable` (and not `MemFree`) and read `Debian GNU/Linux 13 (trixie)` from os-release, but that was a container on a Linux VM.

On 2026-11-01 beelink (Omarchy 4.0.6, Arch-based, kernel 7.1.8, x86_64, 16 threads, 62.3 GiB, Bun 1.4.4) was checked directly:

- **In process.** `os.cpus().length` 16, matching `/proc/cpuinfo`; `os.totalmem()` equal to `MemTotal`; `os.freemem()` equal to `MemAvailable` (not `MemFree`, which was a quarter of it). Two `MachineLoadSampler` readings 10 s apart gave 42.8 % CPU against 42.7 % from `/proc/stat` over the same 10 s.
- **Live backend.** One backend from source, `--runtime-flavor agent-test`, with a disposable data directory, worktree directory and isolated `HOME` (the process environment `createBackendProcessEnvironment` gives a `dev:test` profile's backend, with no credential sources), on an ephemeral loopback port, asked `get_machine_load` over the gateway. Figures are null before the first reading and the first covers 15 s; each was within 0.4 points of `/proc/stat` CPU and 0.6 points of `MemAvailable`-based RAM over the same span (15, 75 and 135 s). The run removed its directory afterwards and left no process.
- **Why not `mise run dev:test` itself.** It starts Electron, and this shell has `WAYLAND_DISPLAY` set, so the window would open on the user's live desktop. The Electron entry has no headless switch, and no headless compositor is installed. The backend Electron would spawn was run directly instead.

The readings needed no change. The OS name did: it now adds `VERSION_ID` when the name has no number of its own and names `ID_LIKE`, so beelink reads as `Omarchy 4.0.6 (like arch)`, live over the gateway as well as in tests. Names that already carry a version (Debian, Ubuntu, Fedora, Alpine's `v3.20`) keep them as they are.

Windows was not run: no Windows machine is reachable from here. `os.version()` is known only from Node's documentation, and a Windows backend is not a supported target today. WSL reads as its distribution, family `linux`.

**Decisions.**
- **What counts as enough?**
  - **Check Linux on the next real Linux node, and Windows only if a Windows backend becomes a target (recommended; Linux done 2026-11-01 on beelink).**
    - Pros: spends effort where machines exist.
    - Cons: Windows wording stays unproved.
  - **Stand up a Windows VM now.**
    - Pros: complete evidence.
    - Cons: effort for a platform with no backend users.

### 4. Older-node detection elsewhere matches the wrong wording

**Problem.** Two existing checks test for the wording `Unknown command: <name>`, but a real backend answers `Unknown backend command: <name>`, and the node link passes that message on unchanged. So these branches are likely never taken against a real older node: `commands-registry-coordinator-nodes.ts:121` (the "runs an older Orkestrator" message) and `nodes/node-service.ts:586` (remembering that a node cannot take settings sync).

**Context.** The test network in `nodes/node-network-test-support.ts:198` answers with the shorter wording, so their tests pass. `packages/protocol/src/view-sync.ts:277` matches the real wording. `readNodeMachineLoad` accepted both until 2026-11-01.

**Investigation.** Read from the code (`OrkestratorBackend.invoke`, `GatewayHandlers.handleInvoke`, `NodeLink.request`): the gateway sends the thrown message as the invoke error and `NodeLink.request` raises it unchanged. Git history agrees: every backend since #76 has thrown `Unknown backend command:`, and the shorter wording came in with #1211's checks and the test network, never from a backend. A third check of the same kind was found: `nodes/node-coordination.ts`, relaying a worker answer to an older node. A new test for each check failed against the old code and passes now. Not reproduced against a real older node (task 2).

**Decisions.**
- **How to fix it?**
  - **One shared `isUnknownCommandError(error, command)` in the protocol package, used by all of these, and the test network switched to the real wording (recommended, done).**
    - Pros: one place to get right, and tests see what production sends.
    - Cons: the test network's change touches several test expectations.
  - **Add the second wording at each site.**
    - Pros: smallest change.
    - Cons: the next check repeats the mistake.

### 5. Keep history across a backend restart

**Problem.** Each backend start empties the history, so a machine restarted an hour ago has an hour of coverage in its 24-hour figure. Releases ship several times a week, so that will be common.

**Context.** The figure stays honest: `coveredSeconds` says how much it rests on. The 5-minute and 1-hour figures, which matter most for placement, recover within the hour.

**Investigation.** The `compatibility-path-usage` store shows the pattern (a database document, a sink opened on first use). It would mean about 15 KB written every few minutes on every machine, all day, plus validation of a stored document, downgrade behaviour and a new shutdown step.

**Decisions.**
- **Persist it?**
  - **Stay in memory until a coordinator is seen being misled by short coverage (recommended).**
    - Pros: no database write traffic and no stored format to keep compatible.
    - Cons: after a restart the 24-hour figure is short.
  - **Persist through a database document.**
    - Pros: the 24-hour figure survives updates.
    - Cons: the costs above, for the least decisive of the three windows.

### 6. Retire the older-node path

**Problem.** `readNodeMachineLoad`'s `older-version` branch exists only for nodes without `get_machine_load`.

**Context.** It is in the [version compatibility register](../../architecture/version-compatibility.md#register), counted as `machine-load.older-node`.

**Investigation.** Nothing to investigate until a Stable release carries the command.

**Decisions.**
- **When to remove it?**
  - **Once the floor is at or above the first Stable release with the command and the counter is quiet (recommended).**
    - Pros: follows the support window.
    - Cons: none of note.
  - **Keep it permanently.**
    - Pros: outside the window a node still gets a clear reason.
    - Cons: a path nobody retires; the `error` reason already covers such a node without failing the call.

## Current state

`list_nodes` returns `machine` for this machine and every connected node. Each backend samples itself once a minute with no reader needed. Live evidence covers one Mac and one Linux host (beelink); Windows and a real node link are unproved (tasks 2 and 3). Every older-node check uses `isUnknownCommandError` (`packages/protocol/src/unknown-command.ts`).

## Constraints and rationale

- A node the user names always wins. Nothing places work automatically.
- Disk, GPU, a Settings or sidebar UI and automatic placement are out of scope, and none was added.
- `list_nodes` must stay fast: one round trip per node to a value already held, with a 2 s limit per node.

## Assumptions and decisions

### Task 1: where the data appears

Added to `list_nodes`, not a new tool. About 400 bytes per machine, and it is the call coordinators already make before choosing. The operator `list_nodes` over the public `node.list` action is unchanged: the public action schema is a versioned contract, and the request was for coordinators.

### Task 1: the source of the readings

`cpuTimes`, `cpuPercent` and the title bar's cached RAM reader are reused, but not the whole `createSystemUsageReader` snapshot as the request suggested. Its stale-baseline rule would turn each CPU reading into a 200 ms point sample, and it also runs the GPU and disk probes. The RAM reader was moved out of it and shared (`hostRamReader`), so the two together run one `vm_stat` per cache period.

### Task 1: the sampling interval

60 s, with the first reading 15 s after start. CPU is an average over the whole interval, so a shorter one would not improve it, and RAM changes slowly.

### Task 1: the coordinator's default

The old line said to work on this node unless the user names another, which left no room to choose. It now says a named node always wins, and otherwise to stay on this node unless load or OS gives a clear reason to move. This is the one behaviour change beyond the data: a coordinator may now place work on another node on its own judgement. Keeping this node as the default means load figures alone do not start moving work around.

### Task 1: fan-out in the tool, not a new command

`list_nodes` asks each node itself. A command-node `get_machines_load` command would need another routing exclusion and has no other caller today.

### Task 1: last-known figures

Never shown. An offline or timed-out node has `status: "unavailable"` and no figures, not even its OS, because a coordinator cannot place work there anyway and a cache would be another thing to keep honest.

### Task 3: the Linux OS name (2026-11-01)

`PRETTY_NAME` stays first, so names that already read well do not change. `VERSION_ID` is added only when that name has no digit at all: the version is the one fact a coordinator cannot guess, and a name with its own number (`Alpine Linux v3.20`) is not given a second one. `ID_LIKE` is shown as `(like arch)`, using the os-release identifiers as they are rather than a table of display names that would need keeping up. It costs a few characters on Ubuntu (`(like debian)`) for telling a coordinator what a niche derivative such as Omarchy or Pop!_OS installs packages with. Only identifier-shaped values are kept, and the 120-character limit on a node's answer still applies. The kernel version was left out: the family and distribution are what placement turns on.

### Task 3: running a `dev:test` profile headless (2026-11-01)

`mise run dev:test` starts Electron, and on beelink that would open a window on the user's desktop session. The check ran the same backend Electron would start, with the same `agent-test` flavour and isolated environment (`createBackendProcessEnvironment`), the way `scripts/qa-command-nodes.ts` starts its backends. The real data directory, logins and the reserved ports were not used. The throwaway script was not kept.

### Task 4: only the real wording counts (2026-11-01)

`isUnknownCommandError` accepts only `Unknown backend command: <name>`, with nothing name-like straight after it, so `get_machine_load_v2` is not `get_machine_load`. `readNodeMachineLoad` used to accept the shorter `Unknown command:` too. That was dropped, because no backend has sent it, and accepting it let the test network's wrong wording pass unnoticed. A peer that did send it gets reason `error`, which also fails nothing. `isUnknownViewCommandError` now delegates to the same function, so it no longer matches a longer command name either. The e2e fake host (`e2e/fixtures/close-retention-host.ts`) still answers `Unknown command:`. It was left alone because it feeds the web client's own handling, and changing what it sends is a separate change. `0395`'s note that an older leaf answers `Unknown command:` was corrected to match.

## Related

- [0048](../transcripts-and-observation/0048-recurring-work-qualification.md): recurring-work qualification.
- [1000](1000-coordinator-self-timers-and-account-switching.md): the routed read tools this follows.
