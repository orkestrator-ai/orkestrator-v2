# Multi-client, restart and older-backend follow-ups

Found on 2026-11-06 by the qualification run for
[0048 task 11](0048-recurring-work-qualification.md#11-multi-client-restarts-and-an-older-backend)
(`e2e/agent-testing/multi-client-restarts-live.spec.ts`, Linux, fake model).
The two defects that run found are fixed in the same change (0048, "Task 11"
decisions T11.1 and T11.2); these are what it left for a decision.

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`. All five tasks done
2026-11-13 against `main` at `17d28238c`.

### Tasks

1. **Queued prompt after a restart-interrupted turn**: a prompt queued behind a turn that a backend restart cut off waits for a later turn, and then runs after a prompt the user typed later. Status: done (2026-11-13: the drain treats `interruption: "restart"` like an idle turn).
2. **Reconnected client freshness**: a client whose link drops converges only on its reconnect ladder (p50 6.3 s, p95 13.1 s after the link returns, over 10 rounds), outside every per-row budget. Status: done (2026-11-13: recorded as a budget row bounded by the ladder).
3. **Register the CLI's local-connection refusal for older backends**: on Linux, `--profile`/`--data-dir` connections refuse every backend from before #1848, which is every published release; `--url` with `--credential-file` works. Status: done (2026-11-13: registered; the refusal names the workaround).
4. **Version notice against an older backend**: today's renderer against v2.21.0 says "Orkestrator has been updated" and asks for a reload that cannot help a hosted client. Status: done (2026-11-13: the notice names an older server and drops a reload that did not help).
5. **A committed older-backend launcher**: the v2.21.0 run used a launcher kept under `output/`; make it repeatable. Status: done (2026-11-13: `scripts/older-release-stack.ts`).

### 1. Queued prompt after a restart-interrupted turn

**Problem.** A user queues prompt Q behind a running turn R. The backend restarts (crash or graceful) while R is at the provider. R settles as failed ("Claude restarted before this turn finished"). Q does not go out. When the user then sends a new prompt F, F runs first and Q goes out about a second after F ends, so the conversation reads R, F, Q although the user asked for R, Q, F.

**Context.** Local bridges die with their backend (the parent-bound wrapper), so no local turn survives a backend restart. The drain (`drainReadyPromptQueue`, `native-agent-prompt-queue-dispatcher.ts`) treats any non-idle status as "the session failed" and defers with back-off (2, 4, 8, 16 s), then parks the head with a `dispatchError` on the fifth attempt. That rule exists so an at-capacity model does not burn a whole queue. The composer sends F directly because the session reads idle-with-error, not busy.

**Investigation.** Observed live in both restart modes on 2026-11-06: no call carried Q in the 8 s after the clients opened; the call carrying Q arrived after F's (`queued-sent-after-later-prompt: true`) and exactly once. Nothing is lost or duplicated; only the order and the wait are wrong for this cause. The drain cannot tell a restart interruption from a provider failure today: both reach it as `status: "error"`.

**Decisions.**

- **What should a queue do after a turn a restart interrupted?**
  - **Classify a restart interruption separately and drain the queue as after an idle turn (recommended).** The bridge or backend already knows the turn ended because its process was replaced; carry that as a failure kind the drain treats like `idle`.
    - Pros: Q runs in the order the user chose, within the 3 s queued-dispatch budget; the at-capacity guard keeps working for real provider errors.
    - Cons: a new failure kind through the bridge contract; a restart loop would send the queue into a session that keeps restarting (bounded by the existing five-attempt park).
  - **Keep holding, but make the composer queue F behind a held Q.**
    - Pros: order kept; no change to the drain's safety rule.
    - Cons: the user still waits for an explicit action, and the hold is invisible until the fifth attempt parks it (about a minute).
  - **Keep today's behaviour and document it.**
    - Pros: no change.
    - Cons: an order inversion the user never asked for.

### 2. Reconnected client freshness

**Problem.** The latency budgets assume a connected client. A client whose link dropped for 3 to 5 s showed the finished turn, the idle state and the diff badge p50 6.3 s and p95 13.1 s after the link returned, while the connected client met every budget.

**Context.** The client's event stream reconnects on 0051's jittered ladder (2, 4, 8, 16 s); the outage link resets connections, so the browser sees no `offline` event that could cut the wait short. Once connected, the client converged within about 50 ms of its first read.

**Investigation.** The spread (p50 6.3 s, max 13.1 s) matches the ladder rung reached during the outage, not backend work. Before the link returned the cut-off client had seen neither the answer nor the badge, so the disconnect was real.

**Decisions.**

- **Is post-outage freshness a budget?**
  - **Record it as bounded by the reconnect ladder (≤ 16 s plus one read) in recurring-work.md's latency budgets (recommended).**
    - Pros: matches what 0051 designed and measured; no new traffic during real outages.
    - Cons: a short outage can leave a client stale for up to one rung.
  - **Retry at once when any request from the page succeeds again.**
    - Pros: converges about as soon as the link is back.
    - Cons: needs a success signal on a page whose only traffic is the stream; more code in the reconnect path 0051 qualified.

### 3. Register the CLI's local-connection refusal for older backends

**Problem.** `orkestrator connection add NAME --data-dir DIR` (and `--profile`) against v2.21.0 is refused on Linux with "restart an upgraded backend to publish its Linux process identity". No published release writes that identity, so a user who upgrades the CLI first cannot use a local connection until the backend upgrades.

**Context.** #1848 (`descriptorProcessRefusal`, `packages/cli/src/client/targets.ts`) refuses a descriptor without `processIdentity` on Linux before any token is read, so a stale descriptor cannot send the token to whoever reused the pid. The version-compatibility register does not list it.

**Investigation.** Observed 2026-11-06: `--data-dir` refused; `--url http://127.0.0.1:<port> --credential-file <data>/gateway-auth.json` connected and ran project, environment and session commands, including a fake-model turn that completed (`succeeded`, 2.9 s).

**Decisions.**

- **How to treat the refusal?**
  - **Register it as a stated limitation with the `--url` workaround, removable once the floor passes the first release with #1848 (recommended).**
    - Pros: keeps #1848's safety property; the refusal already names a fix.
    - Cons: an extra step for local users during the window.
  - **Fall back to the start-time check (as on macOS) when the identity is missing.**
    - Pros: local connections keep working across the window.
    - Cons: reopens the pid-reuse window #1848 closed.

### 4. Version notice against an older backend

**Problem.** Today's renderer served against v2.21.0 shows "Orkestrator has been updated. This page is Orkestrator 2.36.4-beta, but the server now runs 2.21.0. Reload to use the matching version." The server is older, and a hosted client that follows `main` gets the same renderer after a reload.

**Context.** `BackendVersionReminder` serves the "open browser tab → upgraded backend" pairing. The hosted web client → older backend pairing is supported by the window and should not tell the user to reload.

**Investigation.** Seen once in the screenshot taken on 2026-11-06; the renderer otherwise worked (sidebar, turn, legacy diff badge, no page errors). Twelve commands the older backend lacks answered 500 (`changes_get_view`, `get_node_status`, `get_backend_profile`, `get_client_state_capabilities` among them) and the renderer used their fallbacks.

**Decisions.**

- **What should the notice say when the server is older?**
  - **Name the direction: "This server runs an older Orkestrator (2.21.0); some features are unavailable until it is updated", with no reload for a hosted client (recommended).**
    - Pros: accurate; points at the side that needs updating, as the register asks.
    - Cons: needs a version comparison for wording only (allowed: the rules permit versions for messages, not behaviour).
  - **Keep the current text.**
    - Pros: no change.
    - Cons: a reload that changes nothing.

### 5. A committed older-backend launcher

**Problem.** The older-backend case needs a v2.21.0 backend built from the tag, on its own data directory and home, pointed at the profile's renderer, with Docker unreachable (v2.21.0 has no `ORKESTRATOR_HOST_REACHABILITY_CHECK` switch and runs its boot probe). The run used a shell script under `output/`.

**Context.** The procedure is recorded in 0048 ("Multi-client, restarts and an older backend"). The renderer URL changes every time the profile restarts, so the older backend has to be restarted against the new one.

**Investigation.** Not yet started.

**Decisions.**

- **Where should the launcher live?**
  - **`scripts/` with a small Bun entry that archives a tag, installs it frozen, builds its Claude bridge and starts it with the isolation flags (recommended).**
    - Pros: repeatable; the floor moves (v2.21.1 on 2026-12-15), and the script takes the tag.
    - Cons: a script that downloads packages, run rarely.
  - **Keep the documented commands only.**
    - Pros: nothing to maintain.
    - Cons: easy to get the Docker isolation wrong, as the first attempt did.

## Assumptions and decisions

### Task 1: drain after a restart interruption

Chose the recommended option. `readProviderStatus` already carried the
bridges' `interruption: "restart"` (Claude and Codex report it), so no bridge
contract change was needed: `drainReadyPromptQueue` now treats
`status: "error"` with that interruption as idle and sends the head. Every
other terminal error still defers and parks, so the at-capacity guard is
unchanged. A session that keeps restarting takes one queued prompt per
restart, each one the user queued. Covered by
`native-agent-prompt-queue-dispatcher.test.ts` ("after a restart-interrupted
turn"), which fails without the change; `multi-client-restarts-live.spec.ts`
now expects the queued prompt before the later one.

### Task 2: freshness after a client's own outage

Chose the recommended option: a row in recurring-work.md's latency budgets,
bounded by the ladder (≤ 16 s plus one read), pinned by
`web-gateway-reconnect.test.ts`. No retry-on-success signal was added; the
page's only traffic during an outage is the stream.

### Task 3: the CLI refusal

Chose the recommended option: a Register row in version-compatibility.md
(owner 7570 task 6, since #1848 has shipped only in betas so far) and a
refusal that names the first release that publishes the identity
(v2.36.4-beta) and the `--url <its URL> --credential-file <its data
directory>/gateway-auth.json` route. The start-time fallback was not taken: it
would reopen the pid-reuse window #1848 closed.

### Task 4: the version notice

Chose the recommended wording for an older server ("This server runs an older
Orkestrator"; some features are unavailable until it is updated). A hosted
client already got "The Orkestrator backend is out of date" with no reload;
the run's page was classified `backend-served` (the older backend served
today's renderer from a dev server), so the fix is in that branch. A reload
still helps a real rollback (the server then serves its own renderer), so it
is offered once per pair of versions; when the page comes back with the same
pair, the notice drops it. Checked against a real v2.21.0 backend on
2026-11-13: first load offered Reload, the reload came back without it.

### Task 5: the launcher

Chose `scripts/older-release-stack.ts`, reusing the mixed-version harness's
constructed environment and port rules. It archives the tag (npm carries no
v2.21.0 and no renderer), installs it frozen without lifecycle scripts, and
builds only what the mode needs. Two modes: `backend` (an older backend
serving a renderer URL or a profile's renderer) and `renderer` (this backend
serving the tag's renderer, used by 4880 task 3). Beyond 0048's recipe it
sets `ORKESTRATOR_CONTROL_MCP_PORT=0`, because v2.21.0 otherwise binds the
production Control MCP port, and writes the gateway token to the data
directory's owner-only `gateway-auth.json` instead of printing it. Started
v2.21.0 on 2026-11-13: it answered `2.21.0`, bound loopback ports plus its
agent-tools listener on `0.0.0.0` (v2.21.0's own default), and reported
Docker unavailable without probing a container.

## Related

- [0048-recurring-work-qualification.md](0048-recurring-work-qualification.md) task 11.
- [0051-client-reconnect-and-freshness.md](0051-client-reconnect-and-freshness.md): the reconnect ladder.
- [version-compatibility.md](../../architecture/version-compatibility.md): the register and the support window.
