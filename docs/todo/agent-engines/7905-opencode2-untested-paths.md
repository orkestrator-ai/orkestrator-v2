# OpenCode 2 paths the qualification left untested

## Task analysis

Analysed 2026-11-13 against `main` at `17d28238c`.

### Tasks

1. **A container runtime without an egress gateway**: run the container OpenCode qualification on a runtime whose firewall stays inside it. Status: open.
2. **Concurrent sessions on one server**: two OpenCode tabs in one environment take turns at the same time. Status: open.
3. **A steer racing a permission or form prompt**: a steer sent while the turn waits on a card. Status: open.
4. **OpenCode steer through the public CLI and the coordinator's deliver-now**: both still refuse OpenCode steer as unqualified. Status: open (depends on 3).

### 1. A container runtime without an egress gateway

**Problem.** OpenCode 2 in a container was qualified on 2026-11-13 only on a runtime behind its egress gateway (to-do 0008 (retired) task 7). A runtime created without one keeps the firewall inside itself with `NET_ADMIN`, and the OpenCode server there has never been driven on the real stack.

**Context.** `ORKESTRATOR_EGRESS=in-container` creates new runtimes without a gateway (the root `AGENTS.md`, "Network Isolation"); an image without `egress-gateway=1` does the same. The container qualification is `mise run verify:opencode2:container` against a profile started with `--fixture --fixture-environments local,container --no-agent-credentials --agent-platforms opencode --headless --no-host-seed`, on a disposable rootless daemon with `--host-loopback` on a host whose firewall drops container traffic to the profile ([agent-testing.md](../../development/agent-testing.md)). The scripted model serves on the container's own loopback, which the in-runtime firewall also admits.

**Investigation.** Not run. The fake model, the staged configuration and the rebuild case do not depend on where the firewall runs, so the same task should work unchanged with the variable set for the profile's backend.

**Decisions.**

- **How to get a runtime without a gateway?**
  - **Start the profile with `ORKESTRATOR_EGRESS=in-container` (recommended).**
    - Pros: the current image; only the topology changes, so a failure points at it.
    - Cons: needs the variable to reach the profile's backend; check that `dev:test` passes it through.
  - **Build an image from before `egress-gateway=1`.**
    - Pros: the real older-image path.
    - Cons: an old image also lacks later OpenCode 2 support, so a failure would not isolate the firewall.

### 2. Concurrent sessions on one server

**Problem.** Every OpenCode 2 live and real-stack check used one session per server at a time. Two tabs in one environment share one `opencode serve` and its reload gate (`opencode2/reload-gate.ts`), and no check runs their turns together.

**Context.** The 2.x live set (`mise run verify:opencode2:live`, files under `apps/backend/src/core/opencode2/`) runs a scripted loopback model per test and can hold two providers on one server. The reload gate's own unit tests cover the waiting, not two real turns.

**Investigation.** Recorded as untested in 0008 (retired) "Needs verification" since 2026-11-08.

**Decisions.**

- **Where to prove it?**
  - **A new live test in the 2.x set: two sessions on one server, both dispatching, both settling with their own replies, and a steer to one that does not reach the other (recommended).**
    - Pros: deterministic, no browser; reuses the live-server support.
    - Cons: does not show two tabs in the renderer.
  - **A second tab in the idle-observation spec.**
    - Pros: the renderer path.
    - Cons: the spec is already over 2,000 lines and its cases assume one tab.

### 3. A steer racing a permission or form prompt

**Problem.** A steer sent while the running turn is parked on a permission or form card has not been tried against the pinned binary. The backend-held steer guard (0008 (retired) task 10) was proved on running and settled turns only.

**Context.** `opencode2/steer.ts` holds the guard; `opencode2-steer.live.test.ts` covers a late steer and a reused id. The scripted model can ask for a shell command under an "ask" policy, which parks a permission card.

**Investigation.** Not run.

**Decisions.**

- **What should the steer do while a card is parked?**
  - **Prove what 2.2.6 does first, then pin it in a live test (recommended).**
    - Pros: the behaviour is the binary's; a test records it and fails on a bump that changes it.
    - Cons: if 2.2.6 drops or reorders the steer, a product change follows.
  - **Refuse a steer while a card is parked.**
    - Pros: no race to reason about.
    - Cons: a user who wants to redirect a waiting turn cannot.

### 4. OpenCode steer through the public CLI and the coordinator's deliver-now

**Problem.** OpenCode sessions advertise steer, and composer steer is qualified on the real stack in host and container environments (0008 (retired) task 7). The public CLI still reports `steer: false` for OpenCode (`apps/backend/src/core/public-api/providers.ts`), and the coordinator live harness's deliver-now treats OpenCode as unable to steer (`deliverNowApplies` in `apps/desktop/scripts/dev/coordinator-live-deliver-now.ts`), both citing that its steering was not qualified through those paths.

**Context.** The public CLI contract allows a capability only for a provider qualified for it ([public-cli.md](../../architecture/public-cli.md)). Its steer goes through the same backend dispatch as the composer's, but under the CLI's request keys and operation records, and a worker's mail injection steers through the coordinator path.

**Investigation.** Recorded only as code comments until 2026-11-13; no to-do held it. Composer steer evidence: the idle-observation `steer` case on the host (2026-11-11) and in a container (2026-11-13), on scripted models.

**Decisions.**

- **How to qualify it?**
  - **A CLI scenario on a scripted OpenCode model: steer a running turn by request key, retry the same key, and check the turn ends on the steer's reply once; then lift both refusals in one change (recommended).**
    - Pros: no billed turn; the same evidence standard the composer steer met.
    - Cons: needs a scripted-model OpenCode profile in the CLI scenario harness (`mise run test:cli:scenarios`).
  - **Lift the refusals on the composer evidence alone.**
    - Pros: no new harness work.
    - Cons: the CLI's request keys and retries are not what the composer case proves; the contract requires qualification per provider.
- **Order relative to task 3.** Do task 3 first: a steer that races a parked card is the case a CLI caller, who cannot see the card, is most likely to hit.

## Related

- 0008 (retired), the OpenCode 2.x migration: its history is in `git show 17d28238c:docs/todo/agent-engines/0008-opencode-v2.md`; the container qualification it ended with is summarised in [agent-testing.md](../../development/agent-testing.md).
- Real-provider OpenCode 2 checks are in the [manual-test checklist](../manual-test/7568-manual-test-checklist.md).
