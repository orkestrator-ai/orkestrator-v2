# OpenCode 2 paths the qualification left untested

## Task analysis

Analysed 2026-11-14 against `main` at `dc90609bf`.

### Tasks

1. **A container runtime without an egress gateway**: run the container OpenCode qualification on a runtime whose firewall stays inside it. Status: open (needs a container runtime: not runnable on beelink2, whose builds could not reach the Docker socket; run it on a Linux host where they can).
2. **Concurrent sessions on one server**: two OpenCode tabs in one environment take turns at the same time. Status: done (2026-11-14).
3. **A steer racing a permission or form prompt**: a steer sent while the turn waits on a card. Status: done (2026-11-14).
4. **OpenCode steer through the public CLI and the coordinator's deliver-now**: both refused OpenCode steer as unqualified. Status: done (2026-11-14).

### 1. A container runtime without an egress gateway

**Problem.** OpenCode 2 in a container was qualified on 2026-11-13 only on a runtime behind its egress gateway (to-do 0008 (retired) task 7). A runtime created without one keeps the firewall inside itself with `NET_ADMIN`, and the OpenCode server there has never been driven on the real stack.

**Context.** `ORKESTRATOR_EGRESS=in-container` creates new runtimes without a gateway (the root `AGENTS.md`, "Network Isolation"); an image without `egress-gateway=1` does the same. The container qualification is `mise run verify:opencode2:container` against a profile started with `--fixture --fixture-environments local,container --no-agent-credentials --agent-platforms opencode --headless --no-host-seed`, on a disposable rootless daemon with `--host-loopback` on a host whose firewall drops container traffic to the profile ([agent-testing.md](../../development/agent-testing.md)). The scripted model serves on the container's own loopback, which the in-runtime firewall also admits.

**Investigation.** Not run. The fake model, the staged configuration and the rebuild case do not depend on where the firewall runs, so the same task should work unchanged with the variable set for the profile's backend. On 2026-11-14 the work on tasks 2 to 4 ran on beelink2 (Linux, headless), where builds could not reach the Docker socket, so this task was left for a host where they can. It needs no person: an agent on such a host can run it alone.

**Decisions.**

- **How to get a runtime without a gateway?**
  - **Start the profile with `ORKESTRATOR_EGRESS=in-container` (recommended).**
    - Pros: the current image; only the topology changes, so a failure points at it.
    - Cons: needs the variable to reach the profile's backend; check that `dev:test` passes it through.
  - **Build an image from before `egress-gateway=1`.**
    - Pros: the real older-image path.
    - Cons: an old image also lacks later OpenCode 2 support, so a failure would not isolate the firewall.

### 2. Concurrent sessions on one server

**Problem.** Every OpenCode 2 live and real-stack check used one session per server at a time. Two tabs in one environment share one `opencode serve` and its reload gate (`opencode2/reload-gate.ts`), and no check ran their turns together.

**Context.** The 2.x live set (`mise run verify:opencode2:live`, files under `apps/backend/src/core/opencode2/`) runs a scripted loopback model per test.

**Investigation.** Done on 2026-11-14 by `opencode2-concurrency.live.test.ts` against the pinned 2.2.6 on beelink2 (Linux x86_64): a tab's and a pipeline's provider on one server, three sessions dispatching through the shared gate at once. The server listed all three as running together; each settled on its own reply; a steer to one session reached its run only (`steerStatus` `unknown` on the others, the model saw it once); a reload asked for while a dispatch held the gate answered `busy`; a second round on two sessions settled in order. Passed.

**Decisions.** The recommended option: a live test in the 2.x set rather than a second tab in the idle-observation spec, which is already over 2,000 lines and assumes one tab.

### 3. A steer racing a permission or form prompt

**Problem.** A steer sent while the running turn is parked on a permission or form card had not been tried against the pinned binary.

**Context.** `opencode2/steer.ts` holds the guard; `opencode2-steer.live.test.ts` covers a late steer and a reused id.

**Investigation.** Done on 2026-11-14 by `opencode2-steer-cards.live.test.ts` (2.2.6, beelink2). What 2.2.6 does, now pinned: the steer is admitted (`applied`) and waits in the session's inbox; the card stays parked, the session stays `waiting` and the model is not called. Once the card is resolved (a shell permission allowed or denied, a question answered) the tool settles and the steer is delivered at that step boundary in the same run, once. A stop instead leaves the steer in the inbox, and the next prompt's run delivers it before the new prompt; that is [8100](8100-opencode-stop-keeps-pending-steer.md).

**Decisions.** The recommended option: prove what 2.2.6 does and pin it. It neither drops nor reorders the steer while a card is parked, so no product change followed for the race itself.

### 4. OpenCode steer through the public CLI and the coordinator's deliver-now

**Problem.** OpenCode sessions advertise steer, and composer steer was qualified on the real stack, but the public CLI reported `steer: false` for OpenCode (`apps/backend/src/core/public-api/providers.ts`) and the coordinator live harness's deliver-now skipped it (`deliverNowApplies` in `apps/desktop/scripts/dev/coordinator-live-deliver-now.ts`).

**Context.** The public CLI contract allows a capability only for a provider qualified for it ([public-cli.md](../../architecture/public-cli.md)).

**Investigation.** Done on 2026-11-14. The new `opencode-steer` CLI scenario (`packages/cli/scenarios/opencode-steer.ts`, run with `mise run test:cli:scenarios -- --scenario opencode-steer`) runs the packaged CLI and backend on a scripted loopback model, with the pinned OpenCode installed into the scenario's own data directory and no credentials. It holds the turn's first model request open, steers it by request key, retries the same key (same operation, nothing more sent), reuses the key with other text (`request-conflict`), and checks that the turn ends on the steer's reply and that the model saw the steer once. The steer's operation `succeeded`; the start run ended `unknown` with "The turn ended but its outcome was not recorded", which is the public CLI's documented behaviour for any provider when a steer joins the turn (the outcome is recorded against the turn's latest request). Passed. Both refusals were then lifted in the same change.

**Decisions.** The recommended option: a CLI scenario on a scripted OpenCode model, then lifting both refusals together. Task 3 ran first, as recommended.

## Assumptions and decisions

### Task 4: the scenario runs only when named

- **Chose:** mark `opencode-steer` `explicit`, so `mise run test:cli:scenarios` runs it only with `--scenario opencode-steer`.
- **Why:** it downloads the pinned OpenCode binaries into its data directory on every run, which the default credential-free matrix does not otherwise do.

### Task 4: the start run's `unknown` ending is accepted

- **Chose:** the scenario accepts the start run ending `succeeded` or `unknown` with the "turn ended" reason, and follows the turn through the session's transcript.
- **Why:** `public-cli.md` says a steer is a receipt, not a run, and the outcome of a turn a steer joined is recorded against the steer's request; requiring `succeeded` would hold OpenCode to a rule no provider meets.

### Task 1: left open

- **Chose:** leave task 1 open with the reason that it needs a container.
- **Why:** the ticket's constraints for this pass on beelink2 forbid working around an unreachable Docker socket.

## Related

- 0008 (retired), the OpenCode 2.x migration: its history is in `git show 17d28238c:docs/todo/agent-engines/0008-opencode-v2.md`; the container qualification it ended with is summarised in [agent-testing.md](../../development/agent-testing.md).
- 8045 (retired), the turn a backend restart cut short: settled by the OpenCode 2 provider since 2026-11-14 (`apps/backend/src/core/opencode2/restart-cut.ts`); its final state is in Git history at `dc90609bf`.
- [8100](8100-opencode-stop-keeps-pending-steer.md): a stop leaves a held steer for the next turn.
- [8101](8101-linux-reaper-skips-orphans-under-subreaper.md): the reaper skips an orphan a subreaper adopted.
- Real-provider OpenCode 2 checks, including this to-do's tasks 3 and 4 on a real provider, are in the [manual-test checklist](../manual-test/7568-manual-test-checklist.md).
