# OpenCode 2.x migration

Checked against `main` at `8598abfe4` (2026-11-08).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

Status rechecked 2026-10-30 against `main` at `cd7bbe3e5`, and task 2 again on 2026-11-06 against `main` at `ee2cc8423` (2.2.5); see "Assumptions and decisions" and [1031](1031-provider-upgrade-2026-11-06.md) task 7. Upstream rechecked again on 2026-11-08 against `main` at `8598abfe4` (2.2.6), and task 9 added; see "Upstream recheck at 2.2.6".

1. **Upstream recheck**: rerun the recheck procedure against the current 1.x and 2.x releases (the "Needs verification" item). Status: done (2026-10-30, against 2.2.2 and the 1.19.4 pin; see "Upstream recheck at 2.2.2").
2. **Readiness gate and start decision**: decide when the 2.x work may start, using the gate's open conditions. Status: open (trigger decided; still blocked at 2.2.2 by storage policy, per-prompt model/agent/tools and structured output, runtime-context gaps, stale-turn guard, bounded inbox and experimental MCP endpoints; rechecked at the 1.19.5 upgrade on 2026-10-30, still 2.2.2 and unchanged, see [1020](1020-provider-upgrade-2026-10-30.md) task 8; rechecked 2026-11-06 against 2.2.5, still closed, see [1031](1031-provider-upgrade-2026-11-06.md) task 7; rechecked 2026-11-08 against 2.2.6, unchanged. On 2026-11-08 the owner asked to move: steering is required and undo may be dropped. Accepting the other open conditions with the mitigations under "Task 2: owner decision" is proposed but not yet confirmed).
3. **Legacy 1.x session policy**: keep, migrate or retire existing 1.x sessions when 2.x arrives (open question 1, code item 5). Status: done as a decision (keep on a pinned 1.x binary with its own database); the routing code is open (depends on 5).
4. **Losses to decide**: rebuild, capability-gate or drop each of the eight listed losses (code item 3, open question 2). Status: done as decisions (share dropped with 1.19.1; the rest decided below); the code is open (depends on 5).
5. **`opencode2` provider**: a second provider with its own binary pin, `OPENCODE_DB`, `@opencode/client`, persisted protocol marker, snapshot-plus-hints projection and native steer/queue (code items 1, 2 and 4). Status: in progress (phase 1 of the "Build plan" done 2026-11-08; phase 2's toolchain half, the `opencode2` 2.2.6 pin, done 2026-11-08; phase 3 done for host environments on 2026-11-08: the opt-in setting, the session marker, the host 2.x server and per-session routing, with steer on for 2.x sessions; containers done on 2026-11-09 for images that carry `opencode2` (see "Task 5 and 6: container server and GitHub-token plugin"); phase 4 (interaction cards, full transcript, paging, usage) done on 2026-11-09, see "Task 5: phase 4 interactions, transcript and usage"; on 2026-11-09 phase 5's MCP, workflow results, structured output, read-only turns and the move of build pipelines, Multi Review and graph agent nodes under the same switch, see "Task 5: phase 5 MCP, results, read-only turns and workflows"; coordinators, workflows in containers, the rest of phase 5, and phase 6 open; see "Task 5: phase 3 routing and preview setting").
6. **Changes that must ship with the first 2.x pin**: health probe on `/api/info` rejecting HTML, isolated `OPENCODE_DB` on host and container, GitHub-token plugin ported to `@opencode/plugin`, provider sign-in moved to `/api/credential`, live tests off `serve --pure`. Status: partly done (`checkHttpHealth` refuses HTML since 2026-10-30; the compatibility probe no longer uses `--pure`; since 2026-11-08 the 1.x host falls back to its own `OPENCODE_DB` when the shared database has no `session` table; the 2.x binary is pinned from the npm platform tarballs and launched with its own `OPENCODE_DB`, `/api/info` health and a 2.x credential plugin for opted-in host sessions since 2026-11-08; since 2026-11-09 the container 2.x server, with its own `opencode2.db` on the persistent mount, and the GitHub-token plugin ported to the 2.x shape); still open: sign-in through `/api/credential`.
7. **Qualification of the first 2.x pin**: the live probe, background, replay and capability checks listed under "Qualification". Status: open (depends on 5).
8. **Session V2 features after the move**: steer/queue, `switchAgent`/`switchModel`, context, log replay, staged revert, saved rules, credential/integration sign-in, `reference.list`. Status: open (depends on 5).
9. **Transport for the 2.x provider: `opencode acp` behind the ACP bridge, or the `/api/*` HTTP server**: the existing plan assumed the HTTP API; 2.x also ships a full ACP agent. Status: done (2026-11-08): ACP is ruled out because it cannot steer and the owner requires steering; the provider uses the HTTP API.
10. **Steer spike on 2.2.6**: prove the backend-held steer guard (task 5) against the real binary before the provider is built. Status: done (2026-11-08, `scripts/opencode2-steer-probe.ts`; see "Spike results").

### 1. Upstream recheck

**Problem.** The upstream evidence (API mapping, readiness table) was last refreshed against 2.0.18 on 2026-09-27. Picking the work up on stale evidence risks building against routes that have since moved.

**Context.** The file's "Recheck procedure" (steps 1 to 5) and "Needs verification" describe the run. It must use an isolated `HOME`/`XDG_*`: 2.x migrates `opencode.db` in place on start (see "Coexistence and data").

**Investigation.** `npm view` on 2026-10-27: `@opencode/cli` latest is `2.1.4` (published 2026-10-23; 2.1.1 to 2.1.4 between 2026-10-20 and 2026-10-23), so 2.x has moved a minor line since the 2.0.18 checkpoint. `@opencode-ai/sdk` latest is still `1.19.4` (2026-10-22), matching every pin: `apps/backend/package.json:23`, `packages/toolchain/src/manifest.ts:10`, and `OPENCODE_CLI_VERSION` in `docker/Dockerfile` (comment at `docker/Dockerfile:189`, download at `:219`). The SDK patch is `patches/@opencode-ai%2Fsdk@1.19.4.patch`. 1.x is still shipping, so the "stay on 1.x" constraint holds. `mise run verify:opencode:live` exists (`mise.toml:327`). Not yet checked: whether 2.1 published a storage compatibility policy, a steer precondition, or moved MCP out of `/api/experimental`. Done on 2026-10-30 against 2.2.2: see "Upstream recheck at 2.2.2" under Current state.

**Decisions.**

- **When to run the full recheck?**
  - **Now, as a short standalone pass (recommended).** Run steps 2 to 5 against `v2.1.4` and update the tables and gate.
    - Pros: a new minor line is the most likely point for the open gate conditions to change; keeps the "Low" rating honest; cheap (no code change).
    - Cons: costs an isolated 2.x install and an OpenAPI diff for a file that may stay deferred anyway.
  - **Only when someone picks up the migration.**
    - Pros: no work until it is needed.
    - Cons: the readiness gate can open unnoticed; the file's rating rests on evidence a full minor line old.

### 2. Readiness gate and start decision

**Problem.** Without a clear gate the rewrite is either started too early (on an unstable 2.x storage model) or left until 1.x stops shipping, which would force a rushed move.

**Context.** Five gate conditions were met at 2.0.18; six remain open (storage policy, per-prompt model/agent/tools and structured output, runtime-context gaps, stale-turn guard, bounded inbox, MCP endpoints). 0005 (OpenCode steer) and 0028 are blocked on this file.

**Investigation.** No `@opencode/*` dependency exists in any manifest, and there are zero `client.v2.*` call sites in `apps/`, `packages/` or `bridges/`. The upstream state of the open conditions at 2.1.4 is unknown until task 1 runs. No 1.x end-of-life notice is recorded.

**Decisions.**

- **What triggers starting the 2.x provider?**
  - **All open gate conditions met or explicitly accepted, or a 1.x end-of-life notice, whichever comes first (recommended).**
    - Pros: matches the file's rule to stay on 1.x while it ships; an end-of-life notice forces the move with time to spare.
    - Cons: several conditions (storage policy, bounded inbox) may never be formally published, so "accepted" needs an explicit owner decision.
  - **Start once 2.x storage has a compatibility policy, accepting the other gaps.**
    - Pros: unblocks OpenCode steer (0005) sooner; storage churn is the biggest data risk.
    - Cons: ships losses (structured output, read-only tool mask) that break the workflow result broker and read-only turns.
  - **Wait for 1.x end-of-life only.**
    - Pros: least work while 1.x is maintained.
    - Cons: no slack if end-of-life is abrupt; 2.x-only features (native steer, durable replay) stay out of reach.

### 3. Legacy 1.x session policy

**Problem.** Existing OpenCode sessions live in the 1.x schema (`message`/`part`). 2.x migrates them into `session_v2`/`session_message` on start and empties the `event` table, and running 1.x against a migrated database is untested upstream.

**Context.** Open question 1; code item 5 says the 1.x provider retires only after this is decided. Constraint: "Never open a 1.x session through 2.x implicitly".

**Investigation.** Host OpenCode uses the default `~/.local/share/opencode/opencode.db`; no host code sets `OPENCODE_DB`. Containers set it only when the persistent state mount exists (`apps/backend/src/core/container-state-layout.ts:47-48`, `:152`). The session mapping has no protocol marker today.

**Decisions.**

- **What happens to 1.x sessions?**
  - **Keep them on a pinned 1.x binary with its own database; new sessions go to 2.x (recommended).**
    - Pros: no user conversation is mutated or lost; matches the "two binaries" route the file already found is the only coexistence path; the persisted marker makes routing explicit.
    - Cons: two pins, two toolchain entries and two providers to maintain until retirement.
  - **Migrate them through 2.x's own V1 migration.**
    - Pros: one runtime afterwards; upstream owns the conversion.
    - Cons: mutates the database the user's own 1.x TUI uses; migration runs only in the Bun binary; untested rollback; about 6.4 GB on the development host.
  - **Retire them (read-only or hidden) at the switch.**
    - Pros: simplest code.
    - Cons: users lose the ability to continue existing conversations, close to violating the "closing never deletes the conversation" spirit.

### 4. Losses to decide

**Problem.** Eight capabilities have no direct 2.x equivalent; each needs an explicit rebuild, gate or drop before a pin.

**Context.** "Losses to decide" 1 to 8 and open question 2.

**Investigation.** Current usage confirmed: the prompt sends per-prompt `model`, `agent`, `variant` and the tools mask (`apps/backend/src/core/opencode-provider.ts:684-695`, mask `OPENCODE_READ_ONLY_TURN_TOOLS` at `apps/backend/src/core/opencode-provider-helpers.ts:330`; the file's reference to it in `opencode-provider.ts` is stale). Todos are consumed today (`todo.updated` handled at `apps/backend/src/core/opencode-stream-state.ts:726`, listed at `apps/backend/src/core/opencode-events.ts:85`). Share is already off (1.19.1). Structured output lives in `apps/backend/src/core/opencode-structured-output.ts`.

**Decisions.**

- **How to handle the read-only per-prompt tools mask?**
  - **Move it to session permissions, as reviewer sessions already do (`opencode-review-session-permissions.ts`) (recommended).**
    - Pros: reuses a working pattern; permissions are enforced by OpenCode, not by a hint.
    - Cons: a session flips between read-only and writable turns, so permission state must be rewritten per turn and raced against queued input.
  - **Use a separate read-only session per read-only turn.**
    - Pros: no per-turn permission churn.
    - Cons: loses conversation context, which is the point of a read-only turn in the same tab.
- **Todos, LSP and formatter status?**
  - **Capability-gate them off for 2.x sessions (recommended).**
    - Pros: honest UI; 1.x sessions keep them; matches the qualification line "share, todos and LSP off".
    - Cons: a visible parity regression in the runtime summary.
  - **Rebuild todos from tool calls.**
    - Pros: keeps the summary.
    - Cons: 2.x removed the todo tool; 2.2.2 restores it only behind an experimental flag that is off by default.
- **Structured output?**
  - **Use a workflow-result MCP tool, as other providers' result turns do (recommended).**
    - Pros: provider-agnostic; independent of 2.x prompt schema.
    - Cons: relies on the experimental MCP registration endpoint (loss 8) until it stabilises.
  - **Parse a fenced answer from the final text.**
    - Pros: no MCP dependency.
    - Cons: fragile; the broker would accept malformed output or need retries.

### 5. `opencode2` provider

**Problem.** A 2.x server serves only `/api/*`, so the current provider cannot drive it; the move is a new provider.

**Context.** Code items 1, 2 and 4; the rewrite surface list. Inactive-environment invariants apply: `/api/event` has no replay, so the snapshot is authoritative.

**Investigation.** Every file in the rewrite surface still exists under `apps/backend/src/core/` (stream state, events, observation stream, messages, snapshots with `openCodeHistoryCursor` at `opencode-snapshots.ts:68`, display transcript, reconciliation, interactions, provider, review permissions, structured output, capabilities, agent tools, `mcp-management/`). The renderer has no OpenCode client (`apps/web/src/lib/opencode-messages.ts` is gone). 19 non-test backend files import `@opencode-ai/sdk/v2/client` (the file says sixteen), plus `scripts/opencode-live-compatibility-probe.ts`. `apps/backend/src/core/opencode-provider.ts` is 1,403 lines.

**Decisions.**

- **Provider shape?**
  - **A separate `opencode2` provider beside the 1.x one, sharing only pure helpers (recommended).**
    - Pros: the 1.x path stays untouched while legacy sessions exist; avoids branching every call on protocol; respects the no-inheritance rule.
    - Cons: duplicated plumbing (launch, health, credentials) until 1.x retires.
  - **One provider with a protocol switch per session.**
    - Pros: one registration, one capability table.
    - Cons: every method branches; the 1,403-line provider grows past the 2,000-line limit.
- **Adopt native steer in the first release?**
  - **Queue only first; steer behind the expected-turn precondition (recommended).**
    - Pros: follows the file's rule not to advertise turn-pinned `/steer` without a guard.
    - Cons: OpenCode steer (0005) stays unavailable longer.
  - **Ship steer and queue together.**
    - Pros: parity with Claude and Codex.
    - Cons: a steer can land on the wrong turn at the end-of-turn race.

### 6. Changes that must ship with the first 2.x pin

**Problem.** Several hazards would break or silently mislead a 2.x pin, chiefly the health probe reporting a 2.x server healthy.

**Context.** "Concrete changes that must ship with the first 2.x pin" and the hazard note.

**Investigation.**
- Health: `checkHttpHealth` still defaults to `/global/health` and accepts any 2xx (`apps/backend/src/core/commands-server-health.ts:42-66`; `waitForHealth` at `:124`). Callers: `commands-containers.ts:720, 801, 838, 966, 972, 996`, `commands-registry-servers.ts:85, 157, 263, 270`, `agent-accounts-session.ts:24`.
- Database: see task 3; host has no isolated `OPENCODE_DB`.
- Plugin: `buildOpenCodeGitHubEnvironmentPluginSource` at `apps/backend/src/core/agent-credential-files.ts:43`.
- Sign-in: `apps/backend/src/core/opencode-provider-login.ts:426, 461` (`client.provider.oauth.*`).
- Live tests: the compatibility probe now runs `serve` without `--pure` (`scripts/opencode-live-compatibility-probe.ts:374`), so that half is done; `apps/backend/src/core/opencode-review-permissions.live.test.ts:155, 446, 540` still pass `--pure`.
- Distribution: `packages/toolchain/src/manifest.ts:147` and `docker/Dockerfile:219` download GitHub Release archives; 2.x ships only as npm platform tarballs.
- Auto-update guard: `OPENCODE_PINNED_RUNTIME_ENV` (`packages/protocol/src/terminal-agent-launch.ts:17`) is applied in `commands-servers.ts:886`, `host-model-catalog-refresh.ts:358`, `packages/cli/src/client/fix.ts:55`, and `ENV` in `docker/Dockerfile:226`.

**Decisions.**

- **Harden the health probe now or with the pin?**
  - **Now: make OpenCode health checks reject non-JSON 2xx responses on the 1.x route (recommended).**
    - Pros: small, testable today; removes the hazard before anyone tries a binary-only bump; also catches any SPA fallback on a reused port.
    - Cons: touches eleven call sites for a risk that cannot occur while pins are enforced by `tests/unit/version-drift.test.ts`.
  - **With the first 2.x pin, as the file says.**
    - Pros: one change, already in the plan.
    - Cons: leaves a known silent-failure mode in place.
- **Isolate the host `OPENCODE_DB` before 2.x?**
  - **Isolate 1.x only when the shared database is one 1.x cannot open, and 2.x always when it lands (recommended; 1.x half done 2026-11-08).**
    - Pros: a machine whose `opencode.db` an early 2.x build left without `session` works without the user's database being touched; every other machine keeps sharing history with the user's own 1.x TUI and needs no mapping migration.
    - Cons: two database paths to document; once separated, Orkestrator's sessions are not in the user's own TUI.
  - **Only when 2.x lands, and only for 2.x.**
    - Pros: users keep sharing their 1.x history with their own TUI.
    - Cons: a host whose shared database 2.x has left without `session` cannot run any Orkestrator OpenCode at all (observed 2026-11-08).
  - **Isolate it for 1.x now too, unconditionally.**
    - Pros: protects Orkestrator sessions from a user's own 2.x CLI migrating the shared database (the `opencode-go` sign-in case shows users already run 2.x).
    - Cons: Orkestrator sessions disappear from the user's own 1.x TUI; needs a migration of existing mappings.

### 7. Qualification of the first 2.x pin

**Problem.** No 2.x path has been proved on the real stack.

**Context.** The "Qualification" list; live runs are batched in `cross-cutting/0031-live-provider-and-platform-qualification.md`.

**Investigation.** Nothing exists yet: no 2.x tests, fixtures or mise task. The current live task is `mise run verify:opencode:live` (1.x only).

**Decisions.**

- **Where do the 2.x live checks live?**
  - **A new 2.x live test set and its own mise task, alongside `verify:opencode:live` (recommended).**
    - Pros: 1.x keeps its gate while both lines run; failures map to one line.
    - Cons: a second task and probe to maintain.
  - **Extend the existing probe with a protocol parameter.**
    - Pros: one entry point.
    - Cons: one red run hides which line broke; the routes share almost nothing.

### 8. Session V2 features after the move

**Problem.** Native steer/queue, model/agent switching, durable replay, staged revert, saved rules and in-app credentials are only reachable through Session V2.

**Context.** The repository deliberately does not call `client.v2.*` on 1.x. Related: 0005 (steer), 0001 (saved rules), 0006 (staged revert), 0003 (sign-in), and 0175 (whose `session.next.revert.*` events are not consumed).

**Investigation.** `session.next.*` events are known but unhandled (`apps/backend/src/core/opencode-events.ts:34-38` onward, map at `:22`). No `client.v2.*` call sites.

**Decisions.**

- **Try any Session V2 feature through the 1.x SDK's experimental `client.v2.*` before the move?**
  - **No, keep the rule and adopt them on the 2.x provider (recommended).**
    - Pros: avoids the mixed V1/V2 execution on one session the August gaps warned about; no throwaway code.
    - Cons: these features wait for the whole migration.
  - **Adopt queued input or saved rules early through `client.v2.*`.**
    - Pros: earlier user value.
    - Cons: experimental surface on a line upstream is no longer developing; the code would be rewritten for `@opencode/client` anyway.

### 9. Transport for the 2.x provider

**Problem.** Tasks 2 to 8 assume a 2.x provider written against the `/api/*` HTTP server. Most of the gate conditions that keep it closed (no storage policy, experimental MCP add/remove, no per-prompt model or tools, an "Experimental HttpApi surface" label) are properties of that HTTP API. 2.x also ships `opencode acp`, an Agent Client Protocol agent over stdio, and Orkestrator already has an ACP bridge.

**Context.** `bridges/acp-bridge` serves the shared bridge contract (dispatch journal and `/dispatch`, retaining close, transcript v2, approvals that deny on timeout, one row per model response) and is used only by Grok; its non-test sources mention Grok about 390 times, so it is not yet generic. Cursor moved off ACP to its own SDK bridge. OpenCode today runs bridge-less (see agent-engines.md, "Why OpenCode has no bridge"), and that section already says to revisit the decision if fault isolation keeps biting. The current OpenCode provider is about 13,200 non-test lines in 43 `opencode-*.ts` files plus 42 test files.

**Investigation.** Read at tag `v2.2.6`, `packages/cli/src/acp/` (20 files):
- `initialize` advertises `loadSession`, `mcpCapabilities: { http: true, sse: false }`, `promptCapabilities: { embeddedContext, image }` and `sessionCapabilities` with `list`, `resume`, `fork`, `close`, `delete` and `additionalDirectories` (`service.ts:134-141`).
- `session/new`, `load`, `resume` and `fork` each take `mcpServers` (stdio and HTTP). That is a stable way to give a session the Orkestrator agent MCP and the workflow-result tool without the experimental `/api/experimental/mcp/:server` routes.
- Config options `model`, `effort` (the model's variants, category `thought_level`) and `mode` (`config-option.ts`), and `available_commands_update` and `config_option_update` (`sessions.ts`).
- `session/request_permission` for permissions, and questions as `elicitation/create` forms when the client declares form elicitation (`elicitation.ts`; credential prompts are deliberately never elicited).
- `usage_update`, `agent_thought_chunk`, `tool_call_update`, `session_info_update`, and history replay on `session/load` (`replay.ts`).
- Not seen: `plan` updates (2.x has no todo tool by default), any revert/undo, and steer (ACP has no mid-turn input).

**Decisions.**

- **Which transport should the 2.x provider use?**
  - **`opencode acp` behind a generalized ACP bridge (recommended, after a spike).**
    - Pros: ACP is a versioned protocol rather than an API upstream labels experimental, so most of task 2's gate stops applying; MCP per session is stable; the bridge contract (dispatch evidence, close, approvals, transcript v2, row boundaries) already exists and is tested; it gives OpenCode the fault isolation the bridge-less design gave up; the renderer and backend see one more ACP platform instead of a new projection.
    - Cons: the ACP bridge must be made multi-agent (it is Grok-shaped today); Orkestrator owns the transcript instead of reading OpenCode's history, so history paging, change evidence and usage come from the bridge's own records; undo/revert and native steer are lost until ACP or a side channel provides them; questions depend on the bridge declaring form elicitation.
  - **The `/api/*` HTTP server through `@opencode/client` (tasks 5 to 8 as written).**
    - Pros: the richest surface (steer/queue inbox, staged revert, durable session log, `switchModel`, saved permission rules, credentials); closest to today's bridge-less provider.
    - Cons: the API is still labelled experimental and its MCP routes are experimental; the gate has stayed closed through five rechecks; a new ~13,000-line provider against a moving target; no fault isolation.
  - **Stay on 1.x.**
    - Pros: no work; nothing lost.
    - Cons: upstream development is on 2.x (1.x gets backports only); Homebrew, Arch and the README install 2.x, so users' own CLI and sign-ins drift from what Orkestrator runs; the issues that prompted this recheck continue.

**Steering decides it (2026-11-08).** The owner requires steering and accepts losing undo. `opencode acp` cannot steer:
- `turn.ts` refuses a second `session/prompt` while one is active ("Session already has an active ACP prompt").
- ACP has no mid-turn input method.
- `opencode acp` starts its own `opencode serve --stdio --port 0` with a random password (`services/standalone.ts`) and publishes neither the URL nor the password. A side channel to that server for `delivery: "steer"` is therefore not possible without an upstream change.
- A second server of our own on the same `OPENCODE_DB` would rely on cross-process inbox wake-up, which upstream does not describe.

The ACP route is ruled out. The provider uses the `/api/*` HTTP server (task 5), which also keeps staged revert, so undo need not be lost after all.

### 10. Steer spike on 2.2.6

**Problem.** 2.x has no expected-turn precondition, and Orkestrator's steer contract requires one: every bridge answers `409 { outcome: "mismatch" | "idle" }` when `expectedRunId` is not the running turn, and the backend shows "The active turn changed before the instruction could be delivered" (`native-agent-service.ts`). Without a guard, a steer that misses the end of its turn is not refused.

**Context.** Upstream semantics (`specs/v2/session.md` at 2.2.6):
- `steer` delivers in enqueue order at the next safe step boundary. At the idle boundary that ends a run, pending steers deliver before the run settles, so the run continues with them.
- A successful steer wakes execution. A steer admitted to an idle session therefore starts a new run with the steer as its input, rather than being refused.
- `queue` does not wake execution. Pending items can be cancelled (`session.inbox.cancelled`) or changed between `steer` and `queue` (`session.inbox.delivery.changed`).
- Inbox and execution events (`session.inbox.enqueued`/`delivered`, `session.execution.started`/`succeeded`/`failed`/`interrupted`) are durable, ordered by a per-session aggregate sequence. That sequence can be read with `GET /api/experimental/session/:id/log?after=&follow=`. The execution events carry no run id.

Pi has the same shape of problem (its SDK steers without a precondition). It is solved in the bridge, `bridges/pi-bridge/src/http.ts` around the `expectedRunId` checks.

**Investigation.** Source reading only; nothing has been run. The proposed guard, in `OpenCodeProvider` v2:
1. Take the session's dispatch lock, so that Orkestrator itself cannot start another turn in the window.
2. Define the run id as the aggregate sequence of the latest `session.execution.started`. Refuse with `mismatch`, or with `idle` when no execution is open, before sending anything.
3. Journal the steer, then `POST /api/session/:id/prompt` with `delivery: "steer"` and `id` set to the Orkestrator request id. That makes a retry of the same request idempotent upstream (`409 LifecycleConflict` on a conflicting reuse).
4. Settle from the ordered log. `inbox.delivered` before that run's terminal event means `applied`. `inbox.delivered` after a terminal event, inside a newer `execution.started`, means the steer woke a new run. That run is adopted as an ordinary dispatched turn, recorded against the same request id, so the message reaches the agent exactly once either way.

The remaining window is a run OpenCode starts by itself between step 2 and step 3: background-job results continuing a session, or schedules. Schedules are kept off by never setting `experimental.schedules`.

**Decisions.**

- **How should a steer that misses its turn behave?**
  - **Adopt the woken run as a dispatched turn (recommended; the owner's rule for every provider since 2026-11-08, see [0005](0005-mid-turn-steer-and-interrupt.md) task 10).**
    - Pros: matches OpenCode's own semantics and the cross-provider rule; nothing is lost or duplicated; the user sees their message answered.
    - Cons: needs the ordered log to tell `applied` from a new turn.
  - **Enqueue as `queue` and promote to `steer` only after confirming the run.**
    - Pros: an item admitted to an idle session sits pending and can be cancelled, which gives a true refusal.
    - Cons: two calls, so the race moves rather than closes; it relies on `delivery.changed` timing that has not been verified.
- **What must the spike prove?**
  - **The following, on the pinned 2.2.6 binary, in an isolated `HOME`/`XDG_*`/`OPENCODE_DB`, with the scripted local model the 1.x live tests use (recommended):**
    - mid-run delivery at a step boundary;
    - delivery at the idle boundary, where the run continues rather than ending;
    - wake on an idle session;
    - an exact retry of the same id;
    - a conflicting reuse of the id;
    - the ordering of inbox and execution events in the session log;
    - whether `/api/event` frames carry the aggregate sequence, or whether the log route is needed.
    - Pros: settles the only requirement the owner named before any provider code is written.
    - Cons: needs a fake OpenAI-compatible model endpoint for 2.x; the 1.x fixture may not carry over.

**Spike results (2026-11-08).** Run with `OPENCODE2_CLI_PATH=<2.x binary> bun scripts/opencode2-steer-probe.ts --json`. The binary came from `npm pack @opencode/cli-darwin-arm64@2.2.6` (tarball sha256 `613ebb74dd8eff767bb9d442a37b40c4d9946ba27f1538985068a1b9678137a3`, unpacked without install scripts). The run used a disposable `HOME`/`XDG_*`/`OPENCODE_DB` and a scripted local OpenAI-compatible model, and made no remote model calls. The `@ai-sdk/openai-compatible` provider ships inside the binary, so nothing was installed. Observed results:
- **Mid-step steer.** A steer sent while a `bash` tool ran was delivered after the tool result, in the same run: the next model request carried it as the newest user message, and no `idle` row came between.
- **Steer during the final answer.** It continued the same run. The model was called again with the steer, and only then did the run settle.
- **Steer to an idle session.** It started a new run, preceded by an `idle` row, as the spec says.
- **Exact retry of an input id.** `200` with the original record, no extra model call and one stored copy.
- **Conflicting reuse.** The same id with a different text answered `200` with the original record and dropped the new text. This contradicts the spec's `409 LifecycleConflict`, so the provider must compare the returned `payload.text` (or its digest) with what it sent and treat a difference as a conflict.
- **Every re-POST of an existing id wakes an empty run** (`execution.started`/`succeeded` with no model call). That is harmless, but the activity sweep will see a blip of `running`.
- **`queue` on an idle session also wakes it.** This contradicts "queueing does not wake" in the spec, so the "enqueue as `queue`, promote later" option above cannot give a true refusal and is ruled out. `DELETE /api/session/:id/inbox/:inboxID` on an already delivered item answers `204`.
- **Malformed ids.** Input ids must match `^msg_`; anything else answers `400`. The provider therefore derives the input id from the Orkestrator request id (for example `msg_` plus a digest) and keeps the mapping in its journal.
- **Event sequence.** Live `/api/event` frames for durable events carry `durable: { aggregateID, seq, version }`, so ordering and gap detection (a `seq` jump) come from the live stream. `session.text.delta` and `session.tool.progress` are ephemeral and carry none.
- **Session log route.** `GET /api/experimental/session/:id/log?after=0` returned only its `log.synced` marker (`seq` 12) and no events. The log cannot be relied on for history.
- **Snapshot run boundaries.** The authoritative snapshot is `GET /api/session/:id/message` (newest first). It holds the user, assistant and `idle` rows, and each settled run ends in `{ type: "idle", outcome }`. Whether a steer landed in its run or started a new one can be read from the snapshot (is an `idle` row between them?) as well as from `seq` order.
- **Response envelope.** Successful responses are wrapped in `{ data }`.

The guard is therefore buildable as described, with two changes: settle from the live `seq` order plus the message snapshot, not from the log route; and detect a conflicting reuse by comparing the returned payload.

This is the deferred checkpoint for moving from the OpenCode 1.x line to
OpenCode 2.x. The decision is still: do not bump the OpenCode binary or SDK to
2.x. A 2.x server has no legacy HTTP API, so the move is a rewrite of the
backend OpenCode provider rather than a version bump. Upstream evidence was
last refreshed on 2026-10-30 against OpenCode `v2.2.2` (previously 2026-09-27
against `v2.0.18`). The 1.x line was rechecked at `1.19.0` on 2026-10-11/13
(#964) and moved to `1.19.4` on 2026-10-23; `1.19.5` shipped on 2026-10-28 and
is not pinned yet.

Three different things are called "v2" around OpenCode. The file name is kept
for existing links, but the text says "2.x" and never a bare "v2":

- **OpenCode 2.x** is the product line this file is about. It lives on upstream
  branch `v2`, ships under the new `@opencode/*` npm scope, and its server
  serves only `/api/*`.
- **`@opencode-ai/sdk/v2/client`** is the import path that `AGENTS.md`
  ("OpenCode SDK v2 - CRITICAL") requires. It is the current generated client
  of the 1.x SDK, and it drives the 1.x server. Twenty non-test files under
  `apps/`, `packages/` and `bridges/` import it (2026-10-30).
  That rule is correct and unaffected by anything here; "SDK v2" there does not
  mean OpenCode 2.x.
- **Session V2** is the experimental session protocol inside 1.x
  (`client.v2.*`, `session.next.*` events). It is what shipped as OpenCode 2.0.
  The repository has zero `client.v2.*` call sites.

## Current state

- 1.x pin: `1.19.5` for `@opencode-ai/sdk` (`apps/backend/package.json`) and the
  CLI (`PINNED_TOOLCHAIN_VERSIONS.opencode` in
  `packages/toolchain/src/manifest.ts`, `OPENCODE_CLI_VERSION` in
  `docker/Dockerfile`). `tests/unit/version-drift.test.ts` keeps them in step.
  The SDK carries a patch (`patches/@opencode-ai%2Fsdk@1.19.5.patch`, the
  generated SSE client's unhandled `reader.cancel()` rejection).
- 2.x pin (since 2026-11-08): `2.2.6` as the `opencode2` tool
  (`PINNED_TOOLCHAIN_VERSIONS.opencode2`, `OPENCODE2_CLI_VERSION` in
  `docker/Dockerfile`), from the `@opencode/cli-<target>` npm tarballs (glibc
  builds), installed as `opencode2` beside the 1.x `opencode`. It belongs to
  the `opencode` platform (`agentPlatformForToolchain`), so enabling OpenCode
  installs both, on host toolchains and in the image
  (`/home/node/.opencode/bin/opencode2`, `OPENCODE2_CLI_PATH`). Nothing
  launches it yet, and `opencode2` is not an agent platform. The bump procedure
  is in `docs/development/upgrade-agents.md` ("OpenCode 2.x").
- No `@opencode/*` dependency. `session.next.*` events are listed in
  `KNOWN_OPENCODE_EVENTS` (`apps/backend/src/core/opencode-events.ts`) as
  known but unhandled.
- Every OpenCode process Orkestrator starts carries
  `OPENCODE_PINNED_RUNTIME_ENV` (`OPENCODE_DISABLE_AUTOUPDATE=1`,
  `packages/protocol/src/terminal-agent-launch.ts`). That covers terminal tabs,
  `opencode serve` (`commands-servers.ts`) and the model catalogue refresh. The
  container image sets the same `ENV`. The 1.19 TUI otherwise offers to install
  OpenCode 2 in place from `/update`.
- `checkHttpHealth` (`apps/backend/src/core/commands-server-health.ts`) still
  defaults to `GET /global/health`, but since 2026-10-30 a 2xx counts as healthy
  only when it is not `text/html` (`isHealthyHttpResponse`). That closes the
  hazard below for the 1.x route; the 2.x provider still needs `GET /api/info`.
- Containers point `OPENCODE_DB` at `OPENCODE_DB_PATH`
  (`container-state-layout.ts`) when the persistent state mount exists. The
  host uses OpenCode's default `~/.local/share/opencode/opencode.db`.
- `mise run verify:opencode:live` runs the live 1.x compatibility and
  review-permission tests. They start `opencode serve --pure`, which 2.x
  removed.
- Upstream at the last checkpoint:
  - 2.0.0 shipped on 2026-09-11 and 2.0.18 on 2026-09-25.
  - The 1.x line still gets releases and fixes, now cut from upstream's `v1`
    branch (1.19.0 on 2026-10-11). No end-of-life notice for 1.x was found.
  - 2.x packages: `@opencode/cli`, `@opencode/client`, `@opencode/sdk`,
    `@opencode/server`, `@opencode/protocol`. 2.x has git tags but no GitHub
    Releases; binaries ship only as `@opencode/cli-<platform>` npm packages.
  - Upstream treats `opencode upgrade --major` as the official 1.x → 2.x route.

### Why a binary-only bump fails

Verified live on 2026-09-27 with `@opencode/cli@2.0.18` in an isolated
HOME/XDG and `@opencode-ai/sdk@1.18.32`:

| Call (1.18.32 SDK / our raw HTTP) | 2.0.18 result |
| --- | --- |
| `client.session.list`, `client.global.health`, `client.config.get` | throws `Request is not supported by this version of OpenCode Server (Server responded with text/html)` |
| `client.session.create` | `405` |
| raw `GET /global/health`, `/session`, `/config`, `/provider`, `/mcp` | `200 text/html`: the bundled web app's SPA fallback, served before auth |
| raw `POST /mcp` (`configureOpenCodeAgentTools`) | `405` |
| `client.v2.session.list` | `200` JSON, but 11 of the old SDK's 51 `/api` routes no longer exist on 2.x (questions → forms, per-session `history`/`event`, `wait`, `revert/clear`, `/api/health`) |

Upstream removed the legacy routes rather than deprecating them. The server
route table registers only `/api/...` (plus `/auth/connect/:code` and
`/openapi.json`), `packages/opencode` (the 1.x runtime) no longer exists on
`v2`, and `packages/server/src/options.ts` has no legacy toggle.

Hazard: because `checkHttpHealth` accepted any 2xx on `/global/health`, a
binary-only bump would report the server healthy and then fail every session
call. Rechecked on 2.2.2 (2026-10-30): `GET /global/health` still answers
`200 text/html` without auth. `checkHttpHealth` now refuses HTML, so such a
server reads as unhealthy. Any 2.x pin must still move the probe to
`GET /api/info`.

The only way to run both is two binaries: 1.x for legacy sessions and 2.x for
new ones, each with its own data directory or `OPENCODE_DB`.

### API mapping (`/openapi.json`, 2.0.18)

| 1.x (what the provider calls) | 2.x |
| --- | --- |
| `GET /global/health` | `GET /api/info` (`{version,pid,urls,paths}`; 2.2.2 adds optional `hostname` and `capabilities.persistentPty`) |
| `session.promptAsync` / `message` | `POST /api/session/:id/prompt` (`delivery: steer \| queue`, `resume`, idempotent input ID) |
| `session.abort` | `POST /api/session/:id/interrupt` |
| `session.summarize` | `POST /api/session/:id/compact` |
| `session.revert` / `unrevert` | `revert/stage`, `revert/commit`, `DELETE revert` |
| `session.command` | `POST /api/session/:id/command` (field `command` → `name`) |
| `session.fork`, `delete`, `update`, `diff`, `messages` | `fork` (optional `before`), `DELETE`, `PATCH`, `diff`, `message` list/get |
| `question.*` | `session.form.*` / `GET /api/form` |
| `permission.list` / `reply` | `session.permission.*` (`reply` → `decision`), `GET /api/permission/request` |
| `mcp.status` / `add` / `connect` / `disconnect` | `GET /api/mcp`; add/remove/connect/disconnect under `/api/experimental/mcp` |
| `provider.list`, `config.providers` | `GET /api/provider`, `GET /api/model`, `GET /api/model/default` |
| `command.list`, `app.agents`, `app.skills` | `GET /api/command`, `/api/agent`, `/api/skill` |
| `/event` SSE | `GET /api/event`: live only, no replay; durable replay is `/api/experimental/session/:id/log?follow` |
| `session.share` / `unshare` | none ("OpenCode V2 does not support session sharing yet") |
| `session.todo`, `todo.updated` | none: the todo tool was removed (`7feefb697f`); 2.2.2 brings it back behind `"experimental": { "todo": true }`, off by default |
| `lsp.status`, `formatter.status` | none: 2.x does not run LSP |
| none | new: `inbox` (queued input), `background`, `switchAgent`/`switchModel`, `move`, `context`, `environment`, `shell`, `synthetic`, `worktree`, `vcs`, `credential`, `integration` |

The 2.x client package is `@opencode/client` (`OpenCode.make({ baseUrl,
headers, fetch })`), not `createOpencodeClient`. `@opencode/sdk` is now an
in-process embedded host (`OpenCode.create()`), not an HTTP client.

### Upstream readiness at 2.0.18, against the August 2026 gaps

Rechecked at 2.2.2; the rows still hold except where "Upstream recheck at
2.2.2" below says otherwise.

| Gap recorded in August | 2.0.18 |
| --- | --- |
| Specs marked experimental or pre-launch | `specs/v2/session.md` is the "Current semantic overview"; an endpoint audit puts `/api/experimental/*` outside the stable commitment. OpenAPI metadata still says "Experimental HttpApi surface" (stale) |
| V2 tables reset across releases | Last session-state wipe 2026-06-22; migrations since 2.0.0 are additive or a single column reset. No written compatibility policy found |
| `compact`, `wait` return `OperationUnavailable` | Implemented; `wait` is experimental |
| Command, shell, fork, revert, delete, abort, diff, permissions, questions | Present, reshaped as above. Share and todo absent |
| Runtime-context parity | `migrate-v1.mdx` declares three intentional breaks (plugins, server API, `tui.json` → `cli.json`) and lists gaps: no LSP, no `CLAUDE.md` fallback, `compaction.tail_turns`/`prune` ignored |
| No post-crash recovery | Write-ahead execution claim; restart resumes claimed sessions (at most 10 attempts). Running tool calls are marked failed. Exactly-once is explicitly not guaranteed |
| No atomic stale-turn guard for steer | Still no expected-turn precondition. Steer/queue are durable inbox semantics with idempotent IDs and `409 LifecycleConflict` |
| Mixed V1/V2 execution on one session | Moot: 2.x has one runner and no V1 routes |
| Unbounded queues, deltas, tools | SSE: 4,096-frame dropping queue per connection (`SubscriberOverflowError`), 15 s heartbeat. Tool output head+tail bounded. Provider retries at most 4. No inbox length cap found |
| OpenCode's own app uses legacy fallbacks | None: `packages/app` and `packages/tui` depend only on `@opencode/client` |

### Upstream recheck at 2.2.2

Run on 2026-10-30. Upstream reading at tag `v2.2.2` (`098aa7fd6e`) against
`v2.0.18` (`cd9a14a6b6`). Live checks used the `@opencode/cli-darwin-arm64`
tarballs for both versions, in a temporary `HOME`/`XDG_*`, with no sign-in.

- Versions: `@opencode/cli` latest is `2.2.2` (2026-10-29). Since the last
  checkpoint, 2.0.19 to 2.0.32 and 2.1.0 to 2.2.2 have shipped. `@opencode-ai/sdk`
  latest is `1.19.5` (2026-10-28), so 1.x still ships. Upstream's default branch
  is now `dev`; the `v2` branch's last commit is 2026-10-10.
- Health hazard still present: `GET /global/health`, `/session` and `/mcp`
  return `200 text/html` on 2.2.2, `/global/health` without auth. `POST /mcp`
  returns `405`. `GET /api/health` returns `404`.
- Routes: `/openapi.json` has 134 paths, up from 115 at 2.0.18. Nothing was
  removed. The additions:
  - `GET`/`POST /api/credential`, `POST /api/vcs/init`,
    `PATCH /api/permission/saved/{id}`, `GET /api/plugin/gui`,
    `POST /api/integration/{id}/connect/external`, `POST /api/debug/heap-dump`;
  - experimental: schedule, `generate/*`, voice, media, `fs/watch`,
    `client-mcp` and `usage/limits`.

  Its metadata still says "Experimental HttpApi surface".
- Prompt input: unchanged. The `POST /api/session/:id/prompt` body is still
  `id, text, files, agents, skills, metadata, delivery, resume` (identical
  schema at both versions). It has no per-prompt model, agent, tools or
  structured output, and no expected-turn field. Model and agent stay session
  state.
- Storage: there is still no written compatibility policy. Upstream `AGENTS.md`
  now has an "Experimental API" section: `/api/experimental/*` may change without
  guarantees, and shipped SDK or plugin moves keep deprecated aliases for one
  minor. That covers the API, not storage. `CHANGELOG.md` (new) records breaking
  SDK, event and plugin shape changes in 2.1, decoded by compatibility readers
  "no database migration is required".

  Ten migrations were added since 2.0.18 and confirmed applied in the temporary
  database. Three are destructive:
  - `drop_session_allowance` drops a column added the day before;
  - `drop_session_pending` drops an unused table;
  - `azure_cli_external_credential` strips copied tokens.

  `session_part` is a new projection table that is not backfilled. The runner
  has no downgrade guard.
- Runtime context, per `migrate-v1.mdx`:
  - still no LSP;
  - still no `CLAUDE.md` fallback;
  - `compaction.tail_turns`/`prune` still ignored;
  - the todo tool is back behind `"experimental": { "todo": true }`, off by
    default;
  - session sharing was retired upstream for V1 and V2 alike;
  - new breaks: `external_directory` is allowed by default, agent `temperature`
    and options no longer reach the model, local plugin paths must be
    directories, and `OPENCODE_PASSWORD` is the new password variable
    (`OPENCODE_SERVER_PASSWORD` still works).
- Steer guard and inbox: there is still no expected-turn precondition, and no
  inbox length cap.
- MCP: add, remove, connect and disconnect are still under
  `/api/experimental/mcp`; only `GET /api/mcp` and `GET /api/mcp/resource` are
  stable. Session log replay, `wait` and the V1 migration status are still
  experimental.
- V1 migration: still in place on the same `opencode.db`. It empties `event`
  rather than dropping it, and leaves V1 rows intact.
- 1.x end-of-life: no dated notice. Upstream's README, Homebrew's
  `brew install opencode` and the Arch package now install 2.x, and
  `opencode upgrade --major` removes 1.x. Users increasingly run 2.x as their
  own CLI.
- Plugin API: unchanged. `Plugin.define({ id, setup(ctx) })` from
  `@opencode/plugin`; V1's `shell.env` maps to
  `ctx.shell.hook("create.before", (e) => { e.env.X = ... })`.
- 1.x live check: `mise run verify:opencode:live` passed against the pinned
  1.19.4 binary (archive and executable digests matched the manifest): 1 + 3
  tests.

### Upstream recheck at 2.2.6

Run on 2026-11-08 by reading the source: tags `v2.2.5` → `v2.2.6` (515 commits),
plus `dev` at `3ce4ca464d` (79 commits past 2.2.6). The 2.x binary was not run.

- Versions: `@opencode/cli`, `@opencode/client` and `@opencode/plugin` latest
  are `2.2.6` (2026-11-06). `@opencode-ai/sdk` latest is still `1.19.5`
  (2026-10-28), which is the pin. The `v1` branch is still maintained, but with
  backports only (the last is "cap images re-sent from history", 2026-11-07).
  No dated 1.x end-of-life notice.
- Storage: no new migrations in 2.2.6. `dev` changes one line of an existing
  migration (`import_legacy_credentials`). Still no written storage policy.
- Prompt input: `packages/schema/src/prompt-input.ts` is unchanged in 2.2.6 and
  on `dev`. Still no per-prompt model, agent, tools or structured output, and
  no expected-turn field.
- `specs/v2/session.md` is unchanged. The inbox refactor in
  `core/session/inbox.ts` changes no behaviour: still no length cap and no
  stale-turn guard.
- MCP: add, remove, connect and disconnect are still under
  `/api/experimental/mcp/:server` (`packages/protocol/src/groups/mcp.ts`). New
  in 2.2.6: opt-in `pool: true` MCP connection sharing.
- `migrate-v1.mdx` moved from `services/www` to `services/site` with no change
  to its text, so the runtime-context gaps stand.
- Upstream `AGENTS.md` adds a feature-flag policy. Flags are off in releases,
  and `experimental.<key>` or `OPENCODE_FLAGS` turns them on. A 2.x provider
  should set `OPENCODE_FLAGS` explicitly so that a flag shipping or flipping
  cannot change behaviour without a pin change.
- Other 2.2.6 changes for the future provider:
  - `/api/*` now refuses cross-site navigations and requests from disallowed
    origins;
  - `opencode run --archived` and `--worktree`;
  - `client.experimental.job.list()` for background jobs;
  - the ACP agent removes a session that is created and closed without a
    prompt.
- Runtime-context losses, read in the 2.2.6 source on 2026-11-08:
  - **LSP**: the `lsp` config is accepted but no language server runs, and
    there are no LSP tools or diagnostics (`migrate-v1.mdx`, "Supported fields
    without direct native equivalents"). Upstream suggests the project's lint,
    typecheck or compiler commands instead. `core/file-mutation.ts:138` and
    `core/tool/plugin/edit.ts:258` carry "after LSP runtime exists" TODOs, so
    LSP is planned but has no date. This is the one real loss.
  - **Formatters still run** (`core/formatter.ts`; `formatter` config needs no
    migration). Only the status route is gone, and Orkestrator uses it just
    for the count in the runtime summary (`opencode-discovery-metadata.ts`).
  - **Todos**: `OPENCODE_FLAGS=todo` turns on the `todowrite` tool
    (`schema/config/flag.ts`). It is experimental.
  - **`CLAUDE.md` fallback**: 2.x discovers only `AGENTS.md`, but the
    `instructions` config is unchanged, so the provider can list `CLAUDE.md`
    there.
  - **Compaction tuning** (`tail_turns`, `prune`) and **agent temperature and
    options** are ignored. Orkestrator sets none of them.
- Gate: unchanged, all six conditions still open. Task 9 records that most of
  them belong to the HTTP API and would not apply to an ACP transport.
- Host data: the development host's `opencode.db` (2.3 GB) has no
  `session_v2` table, so no 2.x has migrated it. Its `session_message` table
  is empty. No `opencode` is on `PATH`.

## Outstanding work

### Code

Nothing until the readiness gate below opens. Then treat 2.x as a new provider
rather than an upgrade:

1. Add an `opencode2` provider beside the current one. It gets a separate binary
   pin from the npm platform tarballs with new digests, a separate
   `OPENCODE_DB`, `@opencode/client`, and a persisted `legacy` / `v2` protocol
   marker on the session mapping.
2. Build the 2.x projection on `message.list` / the session log as the snapshot,
   with `/api/event` as hints, per the inactive-environment rules. The live
   stream has no replay, so reconnect must re-read the snapshot.
3. Decide each loss below explicitly: rebuild, capability-gate or drop.
4. Adopt native steer and queue through `delivery` and the inbox. Still do not
   advertise turn-pinned `/steer` until an expected-turn precondition exists.
5. Retire the 1.x provider only after legacy sessions have a keep, migrate or
   retire policy.

The rewrite surface is backend-only. Since #970 the renderer has no OpenCode
client or normalizer (`apps/web/src/lib/opencode-messages.ts` is gone). In
`apps/backend/src/core/`:

- events and transcript: `opencode-stream-state.ts`, `opencode-events.ts`,
  `opencode-observation-stream.ts`, `opencode-messages.ts`,
  `opencode-snapshots.ts` (the `before` cursor, `openCodeHistoryCursor`),
  `opencode-display-transcript.ts`, `opencode-stream-reconciliation.ts`;
- interactions: `opencode-interactions.ts` (questions become forms, `reply`
  becomes `decision`);
- prompts: the `session.promptAsync` call in `OpenCodeProvider`
  (`opencode-provider.ts`), with its per-prompt `model`, `agent`, `variant` and
  read-only `tools` mask (`OPENCODE_READ_ONLY_TURN_TOOLS`);
- sessions: `opencode-review-session-permissions.ts`,
  `opencode-structured-output.ts`, `opencode-capabilities.ts`;
- launch and health: `configureOpenCodeAgentTools` (`opencode-agent-tools.ts`), the
  `checkHttpHealth` calls in `commands-containers.ts`, and the GitHub-token
  plugin `buildOpenCodeGitHubEnvironmentPluginSource`
  (`agent-credential-files.ts`);
- MCP management, which reads and writes V1 config keys
  (`mcp-management/`).

Concrete changes that must ship with the first 2.x pin:

- a health probe on `GET /api/info` that rejects HTML;
- the persisted `legacy` / `v2` marker, and an isolated `OPENCODE_DB` on the
  host and in containers;
- the `shell.env` GitHub-token plugin ported to `@opencode/plugin`
  (`Plugin.define({ id, setup(ctx) })`), because V1 plugins do not run on 2.x;
- the live tests moved off `serve --pure`.

### Build plan (2026-11-08)

The 2.x provider is built in phases, each one reviewable, and nothing reaches
users until phase 3 routes new sessions to it.

1. **Foundation. Done on 2026-11-08.** `apps/backend/src/core/opencode2/`:
   - `client.ts`, a bounded typed client for the `/api/*` routes the provider
     uses;
   - `events.ts`, an SSE reader with per-session `durable.seq` gap detection;
   - `steer.ts`, which mints input ids in OpenCode's ascending format, detects
     a conflicting id reuse, and classifies whether a steer landed in its run
     or started a new one;
   - `types.ts`;
   - unit tests, plus `opencode2-steer.live.test.ts` (`RUN_LIVE_OPENCODE2=1`,
     `OPENCODE2_CLI_PATH`) against the real binary through the probe's shared
     fixture.

   Nothing imports it yet.
2. **Toolchain and launch.**
   - **Done on 2026-11-08 (toolchain half).** Pin the 2.x binary per platform
     from the `@opencode/cli-<platform>` npm tarballs: the manifest
     (`opencode2`, 2.2.6), the Dockerfile and the version-drift test. Enabling
     `opencode` installs both binaries (`agentPlatformForToolchain`); see
     "Task 5: phase 2 toolchain pin".
   - **Done on 2026-11-08 for host environments (launch half).** `opencode serve`
     runs with its own `OPENCODE_DB` and config directory,
     `OPENCODE_DISABLE_AUTOUPDATE` and an explicit `OPENCODE_FLAGS`, health on
     `/api/info`, and a 2.x credential plugin (`opencode2/server.ts`,
     `opencode2-host-server.ts`).
   - **Done on 2026-11-09 for containers.** The container launch on port 4102
     (`opencode2/container-server.ts`, `opencode2-container-server.ts`) and
     the GitHub-token plugin in the 2.x shape
     (`buildOpenCode2GitHubEnvironmentPluginSource`); see "Task 5 and 6:
     container server and GitHub-token plugin".
3. **Provider core and routing.** Status: the provider core is done
   (2026-11-08, `opencode2/provider.ts`). Routing, the marker, the host
   server launch and the preview setting are done for host environments
   (2026-11-08; see "Task 5: phase 3 routing and
   preview setting"). The container 2.x server is done (2026-11-09): a
   container whose image lists `opencode2` and publishes port 4102 takes
   2.x sessions under the same switch; an older image stays on 1.x.

   The core is unit-tested against `fake-server.test-support.ts` and
   live-tested in `opencode2-provider.live.test.ts`. It covers create, send
   (with the model switch), dispatch and steer evidence, activity from
   `/api/session/active`, abort with denial, close without delete, and steer
   with run ids. It refuses attachments, images, structured output, workflow
   results, slash commands and read-only turns outright.

   The host launch description is also done (`opencode2/server.ts`). The
   2.x server gets its own `OPENCODE_DB` and config directory under the data
   directory, `OPENCODE_DISABLE_AUTOUPDATE`, and an explicit `OPENCODE_FLAGS`
   with schedules off and the to-do tool on. Readiness is checked through
   `/api/info`. It also writes a 2.x credential plugin
   (`plugins/orkestrator-credential/index.ts`: a plain `{ id, setup }` that
   needs no package), which removes `OPENCODE_PASSWORD` from the server
   process and from every shell it creates. The live test proves both
   sides: without the plugin the agent's shell sees the password, with it
   the shell does not and the server still authenticates. Wiring it into
   `commands-servers.ts` waits for the toolchain branch, which provides the
   `opencode2` binary path. 2.x renamed the `bash` tool to `shell`.

   One finding from the live test: `/api/info` and `interrupt` answer bare
   objects rather than `{ data }`, and the model and agent switches, session
   patch, inbox withdraw and replies answer `204`. The client follows the
   pinned OpenAPI per route.
   - `OpenCode2Provider` covers create and register, send (model, agent and
     permissions set under the session dispatch lock), dispatch evidence (the
     journaled input id in history), activity from the snapshot plus events,
     abort through `interrupt`, steer through `steer.ts`, and close without
     delete.
   - A persisted `legacy` / `v2` marker on the session mapping, read by
     `createNativeAgentProvider`. New sessions go to 2.x, behind a setting
     until phase 6.

   Design, settled 2026-11-08 from a map of the current code:
   - **Routing.** The provider registry caches one provider per (environment,
     agent) (`native-agent-provider-registry.ts`), and both lines mint `ses_…`
     session ids, so the id cannot pick the line. A routing provider
     registered for `opencode` holds the 1.x `OpenCodeProvider` and a lazily
     built `OpenCode2Provider`. It sends each session to one of them by an
     in-memory map, seeded from `registerSession`, whose
     `ProviderSessionRegistration` gains `openCodeProtocol?: "v2"`, and from
     `createSession`, which picks 2.x when the setting says so. An unknown
     session goes to 1.x, so existing sessions never move.
   - **Marker.** `openCodeProtocol?: "v2"` on `PersistedNativeAgentSession`
     (`contract/domains/native-sessions/schemas.ts`); absent means legacy. The
     record is an open record and its validator checks only the fields it
     knows, so no storage migration is needed. The contract manifest is
     regenerated (`mise run contract:check`).
   - **Server.** The 2.x `opencode serve` is a second process per environment,
     with its own port, password, `OPENCODE_DB` and data directory under
     Orkestrator's data directory. On the host it is started by a new command
     beside `start_local_opencode_server_cmd`; in a container it uses a
     second fixed port. Health is `/api/info` through `OpenCode2Client.info`.
     The 1.x health path (`/global/health`, which rejects HTML) is left alone.
     The router receives the 2.x connection through a lazy
     `openCode2Connection()` dependency, so 1.x-only users never start a 2.x
     server. A container connection must name a directory (`/workspace`):
     the 2.x client sends `x-opencode-directory` on every request.
   - **Steer.** `nativeAgentCapabilities("opencode").actions.steer` becomes
     true, and the per-session `steerSupported()` answers false for 1.x
     sessions, which the backend already consults before steering. A missed
     steer starts a new turn, as on every provider (0005 task 10, branch
     `steer-misses-turn-starts-new-turn`).
   - **Dispatch evidence.** The request id travels in the input itself.
     `POST /prompt` with `metadata: { orkestrator: { requestId } }` is echoed
     on the user row in `GET /message`; this was verified on 2.2.6, and the
     server keeps the metadata verbatim. The id belongs to the request, so no
     separate journal is needed, as in 1.x's message-id marker.
     - `dispatchStatus` answers `dispatched` when a history row or a
       still-pending inbox item (`GET /inbox`) carries the request id.
     - It answers `absent` only after a definitive 4xx refusal
       (`OpenCode2RequestError`).
     - Everything else is `unknown`, because a bounded history scan proves
       nothing.

     `send` mints a fresh input id (`mintOpenCode2InputId`) per attempt; an
     ambiguous attempt is never re-posted (the 1.x rule). Message pages carry
     an opaque base64 JSON cursor (`{ id, order, direction }`) for history
     paging.
4. **Transcript and interactions. Done on 2026-11-09 for host sessions**
   (branch `opencode2-interactions-transcript`; see "Task 5: phase 4
   interactions, transcript and usage"). The message history becomes
   normalized rows (one row per assistant message), history pages come from
   the list cursor, permissions and forms become the shared cards (Allow once
   / Deny; no timeout exists to deny on, so stop and close deny), and usage is
   read from the session's tokens and cost.
5. **Feature parity.** The workflow-result tool and structured output over MCP,
   MCP management, sign-in through `/api/credential`, slash commands, staged
   revert, and `OPENCODE_FLAGS=todo`.
   - **MCP, workflow results, structured output, read-only turns and the
     automated callers: done for host environments on 2026-11-09** (branch
     `opencode2-mcp-automation`; see "Task 5: phase 5 MCP, results, read-only
     turns and workflows"). Orkestrator's per-tab MCP connection and the
     workflow-result broker are runtime MCP servers of the 2.x server's
     location (`opencode2/mcp.ts`), confined to their session by its
     permission rules (`opencode2/permissions.ts`); read-only, reviewer and
     result-tool grants are session permissions granted under the session's
     dispatch lock and restored after (`opencode2/turn-grants.ts`,
     `opencode2/workflow-results.ts`). Build pipelines, Multi Review and graph
     agent nodes follow the preview switch. Still open in this phase: the
     user's global MCP servers (the 2.x server reads Orkestrator's own config
     directory, not `~/.config/opencode`), artifact grants and the design
     connection on 2.x workflow turns, coordinators, and graph describe, goal
     verifier and subork sessions (all still 1.x).
6. **Qualification and default.** Task 7, then make 2.x the default for new
   sessions, documented in agent-engines.md.

### Losses to decide

Measured against the current OpenCode usage, which is all legacy
`client.session.*`:

1. Per-prompt `model`, `agent` and `tools`. The 2.x prompt input is only `text`,
   `files`, `agents`, `skills`, `metadata`, `delivery` and `resume`. Model and
   agent become session state (`switchModel`, `switchAgent`). The read-only
   turn's per-prompt `tools` mask has no direct equivalent and must move to
   session permissions. Reviewer sessions already use session permissions
   (`opencode-review-session-permissions.ts`).
2. Structured output. 2.x prompts have no structured-output format, so the
   workflow result broker and `opencode-structured-output.ts` need a new
   mechanism.
3. Share and unshare. Already off: 1.x discontinued sharing in 1.19.1.
4. Todos. `session.todo` and `todo.updated` are gone, so the runtime summary
   loses OpenCode todos.
5. LSP and formatter status. Not available.
6. The GitHub-token plugin (ported as above).
7. The transcript model and events. `message.updated`, `message.part.updated`
   and `message.part.delta` are gone. 2.x emits `session.text.delta`,
   `session.step.*`, `session.tool.*`, `session.inbox.*`, `session.execution.*`
   and `form.*`.
8. MCP registration. The raw `POST /mcp` becomes
   `PUT /api/experimental/mcp/:server`, which is experimental.

### Session V2 features to adopt after the move

These need Session V2. In 1.x they are reachable only through the experimental
`client.v2.*` namespace, which this repository deliberately does not call:

- `delivery: steer | queue` and the inbox (OpenCode steer, see
  [0005-mid-turn-steer-and-interrupt.md](0005-mid-turn-steer-and-interrupt.md));
- `switchAgent` / `switchModel`;
- `session.context`;
- durable event replay through the session log;
- staged revert (`revert/stage`, `revert/commit`);
- saved "always allow" permission rules (`v2.permission.saved` in the 1.x SDK);
- `credential` / `integration` for provider sign-in (see
  [0003-agent-accounts-and-sign-in.md](0003-agent-accounts-and-sign-in.md));
- `reference.list` for `@` mentions.

### Readiness gate

Upstream conditions met at 2.0.18:

- Session events and projections are declared current, not disposable
  experimental state (the stable API excludes `/api/experimental/*`).
- OpenCode's own app no longer depends on legacy session fallbacks.
- `compact` is implemented (`wait` remains experimental).
- Command, shell, fork, revert, delete, interrupt, diff, permission and form
  semantics are implemented.
- Post-crash continuation has documented outcomes (bounded resume, not
  exactly-once).

Upstream conditions still open:

- A documented compatibility and migration policy for 2.x storage across 2.x
  releases. Still open at 2.2.2: there is an API policy, but not a storage
  policy, and three destructive migrations shipped in October.
- ~~Share implemented, or Orkestrator accepts dropping it.~~ Dropped with 1.19.1.
- 2.x equivalents for per-prompt model, agent and tools and for structured
  output, or accepted replacements. Still open at 2.2.2 (prompt schema
  unchanged); replacements are decided under task 4.
- Runtime-context gaps (LSP, `CLAUDE.md` fallback, compaction tuning) closed or
  accepted. Still open at 2.2.2.
- Active-run ownership that supports a stale-turn guard for steering. Still
  open at 2.2.2.
- A bounded inbox, or one the client can bound. Still open at 2.2.2.
- MCP add and remove endpoints out of `/api/experimental`. Still open at 2.2.2.

### Qualification

Before any 2.x pin reaches production:

- SDK, CLI, container and desktop toolchain pinned to one exact 2.x release,
  sourced from the npm platform packages.
- Health probes use `/api/info` and reject HTML responses.
- A live 2.x probe covers create, prompt, exact retry, conflict, message list,
  log replay and tail hand-off, interrupt, permissions and forms, restart and
  teardown.
- Every current `client.session` use has a reviewed 2.x disposition.
- The session mapping persists `legacy` vs `v2`, and 2.x uses an isolated
  database until legacy sessions are retired.
- The GitHub-token plugin is ported to `@opencode/plugin`.
- Background test: run a turn, switch environments, let it progress, and check
  that it rehydrates correctly on return.
- Replay tests cover subscribe-before-snapshot, SSE overflow
  (`SubscriberOverflowError`) and bounded memory.
- Capability flags match 2.x (share, todos and LSP off).
- Native `/steer` tested for idle and end-of-turn races.

### Recheck procedure

1. Compare both lines' pins:

   ```sh
   npm view @opencode-ai/sdk dist-tags.latest   # 1.x
   npm view @opencode/cli dist-tags.latest      # 2.x
   ```

2. Read, pinned to the release tag (upstream's default branch is now `dev`;
   `v2` stopped on 2026-10-10, but releases are still tagged): `specs/v2/session.md`,
   `services/www/src/docs/content/migrate-v1.mdx`, the "Experimental API"
   section of `AGENTS.md` and `CHANGELOG.md` (`V2_HTTP_API_AUDIT.md` was deleted
   in 2.2), `packages/schema/src/prompt-input.ts`, and the database migrations
   in `packages/core/src/database/migration/` since the last checkpoint.
3. Install the 2.x CLI into a temporary directory and run it with an isolated
   `HOME` / `XDG_*`, never against the real data directory. Diff `/openapi.json`
   against the routes the provider calls. `npm pack
   @opencode/cli-<platform>@<version>` and unpacking the tarball avoids running
   any install script; the binary is `package/bin/opencode`. Read
   `/openapi.json` with Basic auth (`opencode:$OPENCODE_SERVER_PASSWORD`).
4. Run `mise run verify:opencode:live` for the 1.x pin. It uses a local fixture
   model, so it makes no billed turns. Set `OPENCODE_CLI_PATH` to the pinned
   binary and run under a temporary `HOME`.
5. Update this file's check line, pins, tables and the readiness gate.

## Constraints and rationale

- Stay on the 1.x line (pin `1.19.4`) for production while 1.x keeps shipping.
  Keep `OPENCODE_DISABLE_AUTOUPDATE=1` on every OpenCode process so a pinned
  binary is never offered the in-place upgrade.
- Never open a 1.x session through 2.x implicitly.
- Coexistence and data:
  - 2.x uses the same `opencode.db` path as 1.x
    (`~/.local/share/opencode/opencode.db`). On start it runs a background V1
    migration (Bun binary only): legacy `session` → `session_v2`,
    `message`/`part` → `session_message`, the `event` table deleted, with
    progress at `GET /api/experimental/migration/v1`. The `event` rows are
    deleted in batches; the table itself stays (corrected at 2.2.2, the same
    at 2.0.18). The 2.x schema has no `message`/`part` tables. The host database on the development machine was
    about 6.4 GB.
  - Starting 2.x against the user's real data directory therefore mutates the
    database the user's own 1.x TUI also uses. Running 1.x afterwards against a
    migrated database is untested upstream.
  - If both versions must run during a rollout, give 2.x its own `OPENCODE_DB`
    (or XDG data directory) and persist the protocol per Orkestrator session.
- Operational differences in 2.x:
  - Distribution: `packages/toolchain/src/manifest.ts` and `docker/Dockerfile`
    download GitHub Release archives; 2.x artifacts must come from
    `@opencode/cli-<platform>` npm tarballs.
  - Auth: a password is always required (generated and printed if unset).
    2.2.2 documents `OPENCODE_PASSWORD`; `OPENCODE_SERVER_PASSWORD` still works
    (verified live on 2.2.2); `OPENCODE_SERVER_USERNAME` is
    ignored and the username is fixed to `opencode`, which is what the backend
    sends. Basic auth, `?auth_token=` or a pairing cookie.
  - Directory scoping: the `x-opencode-directory` header or
    `?location[directory]=`. Sessions carry `location.directory`.
  - Config: V1 `opencode.json` is still accepted and normalized in memory, but
    native V2 keys differ (`agents`; `permissions` as ordered rules with
    `bash` → `shell` and `task` → `subagent`; `mcp.servers.<name>`; `providers`;
    `plugins`). `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`,
    `OPENCODE_CONFIG_DIR` and `OPENCODE_DB` are still honoured;
    `OPENCODE_PERMISSION` is not. Upstream issue #50286 reports the V1
    normalization overwriting a custom provider `baseURL`.
  - Credentials: `auth.json` is imported once into the database and not read
    afterwards; credentials then live in `/api/credential` and
    `/api/integration`. The container entrypoint copies `auth.json` into a fresh
    data directory, which imports on first start, but later host credential
    changes would not propagate.
  - In-app provider sign-in (`opencode-provider-login.ts`) calls 1.x's
    `PUT|DELETE /auth/{providerID}`, `GET /provider/auth` and
    `/provider/{id}/oauth/{authorize,callback}`, which write `auth.json`. It
    has to move to `/api/credential` and `/api/integration` with 2.x. A user
    who already runs 2.x as their own CLI signs in there, and 1.x never sees
    it: that is how an expired `opencode-go` key in `auth.json` kept failing
    in the app while the 2.x CLI worked.
  - CLI: `serve` flags are `--hostname`, `--port`, `--cors`, `--service` and
    `--stdio`. `serve --pure` is gone. The npm bin also installs an `opencode2`
    alias.

## Open questions

- What is the policy for existing 1.x sessions when 2.x arrives: keep them on a
  1.x binary, migrate them, or retire them?
- Which losses are acceptable to drop outright (share, todos, LSP status)?

## Needs verification

- Upstream state since 2026-11-08 (2.2.6): a storage compatibility policy, a
  steer precondition, a bounded inbox, MCP endpoints leaving experimental, or a
  dated 1.x end-of-life. Run the recheck procedure above before picking this
  up, and at each new 2.x minor.
- Task 10 was run against 2.2.6 on macOS arm64 only, with a scripted model and
  one session. Untested: Linux binaries, concurrent sessions, a steer racing a
  permission or form prompt, interrupts, and real providers. The task 9 ACP
  findings were read, not run; they matter only if steering stops being
  required.
- Phase 3 on the real stack: a steer sent from a 2.x tab's composer while a
  turn runs, and the inactive-environment path (start a 2.x turn, switch
  away, return, reload). Both go through code with unit and live provider
  coverage, but neither was driven through the UI.
- Containers (2026-11-09): a preserving rebuild carrying `opencode2.db`, a
  runtime without an egress gateway, Linux amd64, and the
  inactive-environment path for a running 2.x turn in a container. See
  "Task 5 and 6: container server and GitHub-token plugin".

## Assumptions and decisions

Worked 2026-10-30 against `main` at `cd7bbe3e5`. Before acting, each status was
checked against current main. No task's work had merged since the analysis:
there is no `@opencode/*` dependency, no `client.v2.*` call site, and the pins
are still `1.19.4`.

### Task 1: run the full recheck now

Chose the recommended option: run the recheck now as a standalone pass. The
gate depends on upstream state, and two minor lines (2.1, 2.2) had shipped since
the evidence was taken.

The results are under "Upstream recheck at 2.2.2". The run used 2.2.2 rather
than the 2.1.4 named in the analysis, because 2.2.2 is the current latest.
Three corrections were made to the file:
- the V1 migration empties `event` rather than dropping it;
- `OPENCODE_PASSWORD` is the documented variable;
- the todo tool is back behind a flag.

The 1.x pin was not bumped to 1.19.5. That is a routine bump through
`docs/development/upgrade-agents.md`, not part of this file.

### Task 2: start trigger

Chose the recommended trigger: start the 2.x provider when every open gate
condition is met or explicitly accepted by the owner, or when a dated 1.x
end-of-life notice appears, whichever comes first.

At 2.2.2 the gate stays closed. Six conditions are open (storage policy,
per-prompt model/agent/tools and structured output, runtime context,
stale-turn guard, bounded inbox, MCP endpoints), so no provider work started.

The 1.x end-of-life signals (Homebrew, Arch and the README default to 2.x) are
recorded, but they are not a notice. They raise the cost of waiting: more users
will have a 2.x CLI migrating the shared `opencode.db`, which bears on the
task 6 database decision below.

### Task 3: keep 1.x sessions on a pinned 1.x binary

Chose the recommended policy: existing sessions stay on a pinned 1.x binary
with its own database, and new sessions go to 2.x, routed by a persisted
`legacy` / `v2` marker. Nothing in 2.2.2 changes the reasons:
- the V1 migration still runs in place on the shared database;
- running 1.x against a migrated database is still untested upstream;
- the rule "never open a 1.x session through 2.x implicitly" stands.

This is a decision only. The marker and routing are code item 1 and wait for
task 5.

### Task 4: losses

Chose every recommended option:
- the read-only tools mask moves to session permissions (the
  `opencode-review-session-permissions.ts` pattern);
- todos, LSP and formatter status are capability-gated off for 2.x sessions.
  2.2.2's todo tool is experimental and off by default, so the recommendation
  holds; turning it on would put an experimental config key in every 2.x
  session;
- structured output uses the workflow-result MCP tool;
- share stays dropped, since upstream retired sharing for V1 and V2.

These are decisions only, implemented with task 5.

### Task 5: not started

Recorded the recommended shapes (a separate `opencode2` provider; queue first,
steer only behind an expected-turn precondition). No code was written, because
task 2's gate is closed. 2.2.2 still has no expected-turn field, so steer stays
out of the first release.

### Task 6: health probe hardened now, but rejecting HTML rather than any non-JSON

Chose the recommended option (harden now) with one change. `checkHttpHealth`
now refuses a 2xx whose `Content-Type` is `text/html`
(`isHealthyHttpResponse` in `apps/backend/src/core/commands-server-health.ts`),
rather than every non-JSON response. The analysis's wording would have broken
real servers: `checkHttpHealth` serves every bridge, not just OpenCode. The
Claude bridge answers `/global/health` with an unconditional plain "ok", and
many backend fixtures answer with no content type. HTML is exactly the failure
seen live (`200 text/html` from 2.2.2), and no bridge or 1.x server answers
health with HTML.

Since every caller goes through `checkHttpHealth`, the change covers them all
(containers, registry servers, agent accounts, `waitForHealth`,
`confirmRunningServerHealth`, `warmOpenCodeInstance`). The compatibility
probe's own `waitForHealth` already parses the body as JSON, so it was left
alone.

Side effect: `waitForUnhealthy` now treats an HTML-serving process on the port
as already stopped. That only matters for the 2.x-binary case this change
exists to catch; `isHttpServerReachable` still sees it.

### Task 6: `OPENCODE_DB` isolation for 1.x only when the shared database is unusable

Revised 2026-11-08. The earlier choice was to isolate the host database only
when 2.x lands, and only for 2.x. A host then failed every OpenCode start,
the sign-in panel included, with "Database is not empty and has no session
table": its `opencode.db` had been written by the user's own OpenCode 2.
OpenCode 2 migration `20260804233008_loose_psylocke` renames `session` to
`session_v2` in a database that already applied
`20260730195856_optional_session_title`, which only early 2.x builds wrote.
The 1.19.5 pin's start-up test accepts a database only when it has no tables
or a `session` table. A database 2.2.5 creates, and a 1.x database it
migrates, still have `session`. Both were checked on 2026-11-08 with isolated
`HOME`/XDG directories against the real 1.19.5 and 2.2.5 binaries.

The user's database must not be removed or rewritten, so
`apps/backend/src/core/opencode-host-database.ts` now applies 1.x's own test,
read-only, before each host OpenCode start. When it fails, the process gets
`OPENCODE_DB=opencode-orkestrator.db` beside the shared file, and that file is
used from then on. Every other host keeps sharing, as before, so no mapping
migration was needed. The paths covered are local servers, the catalogue and
sign-in servers, `opencode models --refresh`, and both host terminal spawns.
`orkestrator --fix` (`packages/cli/src/client/fix.ts`) is not covered: it
runs the user's own `opencode` without a backend. Isolating 2.x when it lands
is unchanged.

### Task 6: live tests keep `--pure` for now

`opencode-review-permissions.live.test.ts` still starts `serve --pure`, which
1.x supports and 2.x removed. So does `native-agent-suborks-opencode.live.test.ts`
(added 2026-11-04). It runs against the 1.x pin, which is where it
belongs. The move off `--pure` ships with the 2.x live set (task 7), not before. On 1.19.4,
`--pure` means "run without external plugins", which keeps that fixture-model
test independent of plugin installs. Dropping it on 1.x would gain nothing. The
compatibility probe already runs without it.

### Task 7: a separate 2.x live set

Chose the recommended option: a new 2.x live test set and mise task alongside
`verify:opencode:live`. Nothing was built, because there is no 2.x provider to
qualify.

### Task 8: no `client.v2.*` on 1.x

Chose the recommended option: keep the rule and adopt Session V2 features on
the 2.x provider only. The 1.x line still gets fixes, but upstream development
is on `dev`/2.x, so experimental 1.x V2 routes are an even worse base than when
the analysis was written.

### Task 2: owner decision (2026-11-08)

Worked 2026-11-08 against `main` at `8598abfe4`. The owner reported that
staying on 1.x is causing problems, and set two requirements: undo may be
dropped, and steering may not. That ends "wait for the gate". What remains to
confirm is whether the owner accepts the open conditions, each with a
mitigation:

- storage policy: an exact pin, `OPENCODE_DISABLE_AUTOUPDATE`, and an isolated
  `OPENCODE_DB`, so only Orkestrator's own sessions see a migration;
- per-prompt model, agent and tools: `switchModel`/`switchAgent` and session
  permissions, applied under the session dispatch lock (task 4);
- runtime-context gaps (no LSP, no `CLAUDE.md` fallback): accepted as losses;
- stale-turn guard: the backend-held guard in task 10;
- bounded inbox: Orkestrator bounds its own steer journal by count and bytes,
  as the Cursor and Pi bridges do;
- experimental MCP and log routes: used at the exact pin, and rechecked on
  every bump.

### Task 5: phase 1 foundation (2026-11-08)

Built the 2.x client, event reader and steer helpers on their own, with no
production caller, so they can be reviewed and qualified before any routing
exists.

- **Own client rather than `@opencode/client`.** `@opencode/client@2.2.6`
  pins `effect` at exactly `4.1.0` (the backend is on `4.1.2`) and lists
  `solid-js` as a peer. Every read must also be bounded, which the generated
  client does not do. The cost is that our own client has to be updated on
  each 2.x bump. The pinned `openapi.json` is the reference.
- **Input ids are minted in OpenCode's own format**, never derived from the
  Orkestrator request id. The server accepts any `^msg_` id, but its history
  is ordered by those ids, so an arbitrary id would sort out of place. The
  provider must journal the minted id with the request so that a retry reuses
  it.
- **A sequence gap means "re-read", not "lost".** Observed live: 2.2.6 never
  broadcasts some durable sequence numbers, about two per run. Treating every
  gap as a desync is conservative and costs one history read.
- **Conflicting reuse is detected from the answer.** 2.2.6 answers it with the
  original record and `200`, not `409`.

### Task 5: phase 2 toolchain pin (2026-11-08)

Pinned OpenCode 2.2.6 as a second toolchain entry, `opencode2`, beside the
untouched 1.19.5 `opencode`, on host toolchains and in the container image.
Nothing launches it; the launch half of phase 2 is still open.

- **A separate tool named `opencode2`, not a second version of `opencode`.**
  Activation names in the shared `bin` directory must be unique, and the 1.x
  provider resolves `opencode` from it, so the archive's
  `package/bin/opencode` is installed as `opencode2`. A versioned
  `opencode@2` entry would have needed the manager to hold two versions of one
  tool in one activation set, which it does not do.
- **One mapping from tool to platform.** Toolchain names and platform ids used
  to coincide, and the selection filters compared them directly
  (`pinnedArtifactsForPlatforms`, `resolveToolchainSelection`, the two
  `profile-io.ts` filters, and the `dev:test` pending-download check in
  `lifecycle.ts`). They now all go through `agentPlatformForToolchain`
  (`opencode2` → `opencode`, identity otherwise), with
  `agentToolchainsForPlatform` as its inverse for the scenario harness and the
  pending check. The alternative, adding an `opencode2` agent platform, was
  rejected: it would appear in the platform picker and every platform table in
  `packages/protocol` for a binary nothing runs.
- **An explicit `--tool` list stays exact.** Only a platform selection
  expands: `orkestrator toolchain install --tool opencode` installs the 1.x
  binary alone, and `--tool opencode2` the 2.x one. Expanding tool names too
  would have made `--tool` mean two things. The scenario harness asks for both
  through `agentToolchainsForPlatform("opencode")`.
- **npm platform tarballs, no signature repair.** 2.x has no GitHub Release
  assets. The darwin binary passes `codesign -v` as published (checked on
  darwin-arm64), so the installed bytes are the upstream bytes. Glibc builds,
  matching the 1.x Linux artifacts and the Debian image.
- **The image records it.** `docker/image-manifest.ts` lists
  `agents.opencode2` (verified against `OPENCODE2_CLI_VERSION` at build time)
  and `docker/tests/final-image-smoke.sh` checks it, alongside the
  `"$OPENCODE2_CLI_PATH" --version` build check.
- **No backend change.** The backend resolves agents as
  `<toolchainBinDir>/<name>` (`managedBinaryCandidates`), not through
  `*_CLI_PATH` variables, so `opencode2` is reachable the moment the 2.x
  provider asks for it. Host maintenance lists it as its own tool row.
- **Provider state is not traced for 2.x yet.** `PROVIDER_STATE_TRACED_VERSIONS`
  stays per platform and the layout test compares it with each platform's own
  binary only. The 2.x state layout (its own `OPENCODE_DB`) is traced with the
  launch work.
- **Branch base.** Built on the phase 1 branch so the build plan above exists
  in the same history.

### Task 5: phase 3 routing and preview setting (2026-11-08)

Wired the 2.x provider into interactive native tabs on the host, behind a
setting. Branch `opencode2-routing`, from `506120f42` (the phase 2 branch).

What exists now:

- **Setting.** `openCodeProtocol: "legacy" | "v2"` on the global config
  (`packages/protocol/src/opencode-protocol.ts`, the config contract,
  `storage-config.ts`), absent meaning legacy. A save from an older renderer
  keeps the stored value, as `multiReviewEngine` does. It is not one of the
  settings a command node hands down: whether `opencode2` is installed is a
  property of each machine. The renderer control is "Use OpenCode 2 for new
  sessions (preview)" in Settings → OpenCode
  (`OpenCodeProtocolSetting.tsx`).
- **Marker.** `openCodeProtocol?: "v2"` on `PersistedNativeAgentSession`;
  the backend validator accepts it only on an OpenCode record, and
  `getOrCreateNativeAgentSession` refuses it on any other agent. The contract
  manifest is regenerated; no domain version changed (a new optional field).
- **Which sessions take 2.x** (`native-agent-opencode-protocol.ts`): a new
  session whose origin is `interactive-native`, whose owner is absent or an
  environment, with no backend execution policy, in a local environment,
  while the setting says `v2` and the backend has a 2.x host. The decision is
  made once in `ensureSession`, stored on the record and passed to the
  provider's `createSession` as `openCodeProtocol: "v2"`. An existing session
  keeps its line whatever the setting says later. Build pipelines, Multi
  Review and graphs build their providers without the router
  (`build-pipeline-provider.ts`, `graph-agent-providers.ts`) and create
  sessions with other origins, so neither the setting nor a 2.x record can
  reach them.
- **Host server** (`opencode2-host-server.ts`,
  `opencode2/host-server-state.ts`). One `opencode2 serve` per local
  environment, started only when a 2.x session needs it: `openCode2HostLaunch`
  plus `writeOpenCode2HostConfig`, an ephemeral loopback port, a password from
  `mintBridgeToken` kept only in process memory, cwd the worktree, ready on
  `/api/info` through `waitForOpenCode2Ready`. It is reused while its process
  lives in the same worktree, owned under `opencode2:<environmentId>` (so
  backend shutdown terminates it and an unrequested exit is reaped), and
  stopped by `stopLocalServerUnlocked` whenever the environment's 1.x server is
  (environment stop, delete, explicit stop). Starts are serialized per
  environment by the environment operation queue and host-wide by their own
  gate, because every host 2.x server shares one `OPENCODE_DB`. The backend's
  own agent-tools MCP credential and coordinator variables are removed from
  its environment. Only the managed `opencode2` binary is used; there is no
  PATH fallback (an `opencode` on PATH is normally 1.x).
- **Routing** (`opencode2/routing-provider.ts`), see the decision below.
- **Steer.** `nativeAgentCapabilities("opencode").actions.steer` is true;
  `OpenCodeProvider.steerSupported()` answers false, and the router answers
  true only for a 2.x session. Every steering surface already checks
  `steerSupported` per session (projection, composer, auto-steer, queued
  steer, agent mail, pipeline and review mail), so a 1.x session degrades to
  the queue as before.
- **Capabilities.** A provider snapshot may carry `capabilityLimits`
  (`ProviderCapabilityLimits`), which the projection applies to the
  platform's capabilities (`native-agent-capability-limits.ts`). A 2.x
  session reports no compact, undo, redo, rewind, share, fork, attachments or
  slash commands, so its tab does not offer them.
- **Transcript (preview).** `opencode2/transcript.ts` turns user and
  assistant rows into the shared rows (text, reasoning, tool calls with
  bounded inputs), enough for a readable tab. Phase 4 is still the real
  projection.

Decisions:

- **How sessions are routed.**
  - **A routing provider registered for `opencode`, holding the 1.x provider
    and a lazily built 2.x one, routing each call by the session's recorded
    line (implemented).**
    - Pros: the registry, its cache key and every caller stay unchanged; the
      line is per session, so 1.x and 2.x sessions coexist in one
      environment; the 2.x server starts only for a 2.x session.
    - Cons: every provider member needs a 2.x answer, even an empty one; a
      session the router has not seen needs one storage lookup.
  - **A protocol-aware provider cache key, threaded from the session record
    into `ProviderRegistry.resolve`.**
    - Pros: optional members are naturally absent on a 2.x provider.
    - Cons: the cache key is also the observation group, the activity group,
      the projection's provider lookup and the tab-close and move paths; each
      would need the session's protocol, and one missed site would serve a
      2.x session from the 1.x server, which reads it as missing and replaces
      it.
  - Recommendation: the routing provider. A session's line comes from, in
    order, its creation through the router, a registration carrying the
    marker, or its persisted record. A failed lookup is an error rather than
    1.x, for the reason above. Every provider the service caches for an
    environment (the registry, tab close, the move check) is built with the
    router.
- **Which line an unknown session takes.**
  - **1.x unless its record says 2.x (implemented).** Pros: every existing
    session stays where it is. Cons: a 2.x session whose record was lost is
    read on 1.x; there is no such path today.
  - **Ask both servers.** Pros: survives a lost record. Cons: starts a 2.x
    server for every 1.x session; both lines mint `ses_` ids.
  - Recommendation: the record.
- **Observers and the 2.x server.**
  - **Never start it from an observer (implemented).** `activity`,
    `activityBatch`, `abort` and `closeSession` use a running server only; a
    2.x session with no server reads idle. Pros: the activity sweep cannot
    spawn a server per environment. Cons: none found; a server that is not
    running has no turn in flight.
  - **Start on any call.** Cons: the two-second sweep would start a server
    for every environment that ever held a 2.x session.
  - Recommendation: never from an observer.
- **Capability honesty.**
  - **Per-session `capabilityLimits` on the provider snapshot
    (implemented).** Pros: one small, removing-only field, applied where
    `interactionKinds` and the steer qualification already narrow the table.
    Cons: surfaces that read the platform table directly (the draft
    attachment filter, the CLI) still see OpenCode's table; the 2.x provider
    refuses those requests with a clear error instead.
  - **Refusals only.** Cons: the tab would offer undo, compact and
    attachments that then fail.
  - Recommendation: limits plus refusals.
- **Public CLI steer.** The CLI's provider table answers per platform, so it
  keeps OpenCode steer off (`public-api/providers.ts`) until the preview is
  qualified; otherwise `session.steer` on a 1.x session would fail late with
  `operation-failed` instead of `capability-unavailable`.
- **Host server as an internal function, not a registered command.** The
  native-agent service gets it through `NativeAgentServiceOptions.openCode2HostServer`
  (`index.ts`). Pros: no new contract surface, and the password never
  crosses a command boundary. Cons: no renderer or CLI can start or inspect
  the 2.x server; nothing needs to yet.

Known gaps, for phases 4 and 5:

- No permission or form cards on a 2.x tab: a parked request reads as
  `blocked`, and the tab shows a warning notice that says so and suggests
  stopping the turn. (Closed by phase 4.)
- The model catalogue, resume list and sign-in are the 1.x ones. The 2.x
  session takes the model on create and on each prompt; the execution
  profile (Plan/Build agent) and the session `policy` are not sent yet.
- No agent-tools MCP on 2.x (its MCP routes are under `/api/experimental`),
  so a 2.x tab has no Orkestrator mail or ticket tools. Done 2026-11-09, see
  "Task 5: phase 5 MCP, results, read-only turns and workflows".
- The transcript has no tool output, diffs, sub-agents, history paging,
  usage or terminal-error rows. (Closed by phase 4.)
- 2.x events do not reach the observation hints, so a 2.x session keeps the
  activity sweep at full cadence (`observationStreamLive` answers false while
  one is known).
- `coordinator-deliver-now` now reports an OpenCode 1.x recipient as
  "queued until idle" rather than "unsupported, queued": the platform table
  says steer, and the mail delivery falls back once `steerSupported` says
  no. The message is queued either way.
- Containers: done on 2026-11-09 (port 4102, `directory: /workspace`); see
  "Task 5 and 6: container server and GitHub-token plugin".

Evidence: unit tests for the router, transcript, setting, marker, service
selection and projection narrowing; the host server against a stand-in
binary; and `opencode2-routing.live.test.ts` against the real 2.2.6 binary
with a scripted model (session created through the router on the
environment's own 2.x server, prompt dispatched with its request id, reply
shown in the snapshot, server reused, then stopped with OpenCode).

Real stack, 2026-11-08, throwaway profile `oc2-routing-a1a9` (`dev:test
--fixture --agent-platforms opencode --no-agent-credentials`, since stopped
and reset): the profile downloaded `opencode2@2.2.6` beside `opencode@1.19.5`;
the setting was turned on in Settings → OpenCode and survived a reload; a
local fixture environment was created and `orkestrator session start --agent
opencode` started a session. The backend logged `host-server.ready` for the
environment, an `opencode2 serve` child ran beside the 1.x `opencode serve`
under the profile backend, the 2.x database appeared at
`<data>/opencode2/opencode.db`, and the tab showed the prompt and the model's
"ok" (OpenCode's own free default model, no credentials) with 2.x message ids.
After `dev:stop` no profile process was left. Not checked live: a steer from
the composer, and the inactive-environment path for a running 2.x turn.

The renderer's attach button and the draft-attachment filter still read the
platform table, so a 2.x tab still shows the attach button; a send with an
attachment is refused with "OpenCode 2.x sessions do not support attachments
yet". The execution-profile (Plan/Build) picker is also still shown and its
choice is not sent to 2.x.

### Task 5: phase 4 interactions, transcript and usage (2026-11-09)

Branch `opencode2-interactions-transcript`, from `862789fcd`. New modules
under `apps/backend/src/core/opencode2/`: `interactions.ts` and `forms.ts`
(cards), `transcript.ts` and `transcript-tools.ts` (rows),
`transcript-snapshot.ts` (windows, pages, revised rows), `session-state.ts`
and `usage.ts` (state, usage, sub-agent hydration), and `reads.ts`, which
`OpenCode2Provider` owns and delegates to. The router forwards
`interactions`, `transcriptSnapshot`, `transcriptPage`,
`sessionStateSnapshot`, `interactiveSnapshot` and a new `refreshUsage` for
2.x sessions; the phase 3 "waiting" notice is gone.

What exists now:

- **Cards.** `GET /api/session/:id/permission` and `/form` are read on every
  snapshot. A permission is a `permission` card with "Allow once" and "Deny"
  only; `approve-for-session` and an answer carrying content are refused
  before anything is sent; deny, decline and cancel send `reject`. An edit
  permission's card shows its diff (`metadata.files[].patch`). Forms are
  `question` cards: `string` (with or without options, free text when
  `custom`), `multiselect`, `boolean` (Yes/No), `number`/`integer` (free text,
  parsed and range-checked here), `external` ("Done" plus the URL), and any
  other kind as free text the server judges. Hidden fields answer with their
  default; conditional (`when`) fields are optional with the condition in the
  description, and an answer to an inactive one is dropped. A form with more
  than 16 shown fields is shown with confirm disabled, so it can only be
  declined. A reply is `applied` only once the request has left the pending
  list; a 404 is `already-resolved`, a 4xx `rejected` with the card kept.
  Orkestrator's permission rules (0723) get a detail for a one-command shell
  request, a one-file edit and a one-URL webfetch.
- **Transcript.** One row per 2.x row; every row kind has a fate in
  `OPENCODE2_ROW_FATES` and an unknown one is dropped and logged once
  (`transcript.unknown-row`, kind only). Assistant rows carry text, reasoning,
  tool cards with state, input, output, duration and edit diffs, sub-agent
  cards (`subagent` tool, `metadata.sessionID`, active while a background
  child runs), a pending `retry` part, and an inline error row when the
  response failed. `idle` rows show a failed run as an inline error (deduped
  against the response's own) and a stopped one as "Interrupted by user".
  `shell`, `compaction`, `synthetic`, `system` (description only, never the
  instruction text), `skill` and agent/model switches have rows too.
- **Windows and pages.** `transcriptSnapshot` reads at most 199 rows plus one
  (2.2.6 refuses `limit` above 200), trims whole rows to the reader's byte
  target, and names `historyCursor`/`historyCursorBefore` in the server's own
  cursor format. `transcriptPage` pages through the list route; an empty page
  is checked against its anchor row, so a revert expires the cursor instead
  of claiming the start of history. Events whose data names an
  `assistantMessageID` note revised rows; one outside the window is fetched
  once per change and sent as a revised row.
- **State and usage.** `sessionStateSnapshot` reads the session (title,
  lifetime tokens and cost, model, last outcome) and the newest assistant row;
  a failed last run reads `error` with the idle row's message, a stopped one
  carries a `stopped` notice. Cost is `estimate` (2.x prices from the
  catalogue), unknown for GitHub Copilot.

Decisions:

- **Timeouts.**
  - **No backend deadline, as on 1.x (implemented).** Pros: matches the
    documented stance in agent-engines.md ("No backend timer stands in for
    one, by choice"); OpenCode publishes none, so there is nothing to show or
    pause; stop and close reject everything parked, and only interactive
    sessions reach 2.x. Cons: a card nobody answers waits until the turn is
    stopped.
  - **A backend `InteractionDeadline` per request that rejects on expiry.**
    Pros: a literal reading of "deny on timeout". Cons: contradicts the
    documented decision for every provider without a published deadline, and
    needs hold state the backend has never kept.
  - Recommendation: no deadline.
- **Where live events count.**
  - **Hints only (implemented).** Every event for a session moves its
    revision, so `unchanged` is answered only while the stream is connected
    and nothing arrived; a dropped stream, an oversized frame or a reconnect
    moves every revision and the revised-rows overflow version. A `durable.seq`
    gap moves only the revision, because 2.2.6 skips about two sequence numbers
    per run and treating each as lost notes would re-page retained history
    every run.
  - **Gap as lost notes too.** Pros: strictly conservative. Cons: a full
    history reconcile per run on 2.2.6.
  - Recommendation: hints, with gaps as re-reads.
- **Usage.**
  - **The session's own lifetime ledger (implemented).** Pros: authoritative,
    never under-counts a long job. Cons: one more small read per state
    snapshot.
  - **Summing the transcript window, as `usageFromMessages` does on 1.x.**
    Cons: a window under-counts. The router's `usageFromMessages` stays 1.x
    only: its input for a 2.x session is normalized rows with no tokens, and
    the goal-budget path reads `sessionStateSnapshot` first.
  - Recommendation: the ledger.
- **Sub-agent actions.** Hydrated from the child session (eight children,
  fifty rows each) in `interactiveSnapshot` only, as 1.x does; the progressive
  window shows the card without its actions.
- **`permissionRuleDetail` in the router is synchronous.** The phase 3 router
  wrapped it in an `async` function, which the enforcer reads synchronously;
  a promise is truthy and would have been taken for a detail. It now answers
  from the known line, `null` for a session not yet routed.

Not done:

- Containers (as for phase 3).
- A `todo` tool card with a task snapshot; it renders as a plain tool card.
- File results of a tool (`Tool.FileContent`) are named in its output, not
  shown as images.
- The renderer shows "Completed in 0s" under a response row whose tool is
  still waiting on a permission (seen live); it reads the response's own
  completion time.

Evidence: unit tests for every module against `fake-server.test-support.ts`
(now with session reads, cursors, single-row reads, form replies and the
200-row cap); `opencode2-interactions.live.test.ts` on the real 2.2.6 binary
with the scripted model (shell and edit set to `ask`): an Allow once card that
runs the tool and shows its output, a denied call, an edit card with its diff
and file rule, a question-tool form answered through its card, and a stopped
turn whose parked request is rejected and whose history pages back to its
start. Real stack, profile `oc2-cards-a352` (since stopped and reset): with
the preview setting on and shell set to `ask` in the fixture worktree's
`opencode.json`, OpenCode's free default model asked to run `ls -la`; the
card appeared on a freshly loaded page, "Allow once" ran it and the
transcript showed the output; asked to use its question tool, it raised a
question card that was answered in the browser and reached the model.

### Task 5: phase 5 MCP, results, read-only turns and workflows (2026-11-09)

Branch `opencode2-mcp-automation`, from `862789fcd`. Owner decisions 2 and 4
of 2026-11-09 applied.

What exists now:

- **MCP routes** (`opencode2/client.ts`, `opencode2/mcp.ts`): `GET /api/mcp`,
  `PUT`/`DELETE /api/experimental/mcp/:server`, `connect`, `disconnect`. On
  2.2.6 these are scoped to the server's location (the worktree), not to a
  session, and a runtime server lives in the process only (never in
  OpenCode's database or config). A `PUT` answers `204` at once and the
  server reports `pending` until it connects, so registration polls
  `GET /api/mcp` for `connected` (10 s bound) and refuses the turn otherwise.
  Orkestrator registers with `codemode: false`, so the model sees the tools
  directly as `<server>_<tool>`.
- **Per-tab agent MCP.** A 2.x session takes the per-tab credential
  (`sessionTakesAgentTools`, used at session creation and dispatch in
  `native-agent-service.ts`; OpenCode's platform table still says no, because
  1.x's connection is environment-wide). Each session's connection is its own
  server `orkestrator_tab_<12 hex of sha256(session id)>`; a rotated token
  re-registers it, and closing the tab removes it.
- **Isolation by session rules** (`opencode2/permissions.ts`). Every
  session's rules end with: deny `orkestrator_tab_*`, deny
  `orkestrator_workflow_result_*`, allow its own tab server. 2.2.6 leaves a
  tool whose action is denied for every resource out of the model's list, so
  another tab's tools are neither offered nor callable. Child sessions copy
  their parent's rules at creation (`session.ts`, "Children inherit metadata
  and permissions"), so a sub-agent cannot reach another tab's server either.
- **Workflow results.** A result turn's `agentMcp` is the environment's broker
  credential (`workflowResultConnection(…, "opencode")`, unchanged for
  callers), registered as `orkestrator_workflow_result`; the prompt carries the
  attempt's capability as on 1.x. The turn's own tools are granted for the
  turn (the 1.x rules from `openCodeWorkflowResultPermissionRules`,
  translated, plus a deny of the tab server's `ask_agents`), and restored by
  `settleTurn` once the request's run has an `idle` row, by abort and by
  close. Ownership (`metadata.orkestrator.turn = { version, requestId,
  settled }`), the session's base rules and its reviewer marker are session
  metadata, so a recreated provider settles correctly and an older request
  cannot settle a newer grant. A grant that does not read back refuses the
  turn before the prompt, and the request then reads `absent`.
- **Structured output** (`structured-output-v1` turns): the prompt asks for one
  final JSON value (1.x's `openCodeStructuredPrompt`) and `structured` parses
  the run's last answer once it settled; a failed run is `provider_error`, an
  unparseable answer `malformed_output`.
- **Read-only turns.** Session rules for the turn: the base rules, then deny
  `edit` (2.x's write, edit and patch), `shell`, `subagent`, `todowrite`,
  `webfetch`, `websearch`, `experimental_image_generate` and `opencode_*`
  (worktree, schedule, artifact and session tools). A reviewer (a session
  created with `reviewerSession` and a policy, marked in its metadata) gets
  1.x's constrained shell rules instead (`openCodeReviewPermissionRules`,
  translated: `bash` → `shell`, `task` → `subagent`, `write`/`patch`/
  `apply_patch` → `edit`). A backend execution policy becomes the session's
  base rules at creation (`openCodePermissionRules`, translated).
- **User MCP servers.** `mcpServers`/`mcpServerAction` list and toggle the
  location's servers, Orkestrator's own left out.
- **Workflows on 2.x** (`openCodeWorkflowRoutingDependencies`,
  `ProviderDependencies.openCode2Workflow`, wired in `index.ts` for build
  pipelines, Multi Review and graph agent nodes). Their providers are the
  routing provider; a new session takes 2.x when the setting says `v2`, the
  environment is local, the session has a policy that does not ask, and is
  not a coordinator. The id is recorded in a new `opencode2-sessions` store
  (one row per environment, at most 4,096, deleted with the environment's
  native sessions) before the caller sees it, so a run never changes line;
  the interactive lookup reads the same store, so a tab opened on a
  workflow's session finds it on 2.x.

Decisions:

- **How a per-tab credential reaches only its session.**
  - **One location server per session, confined by session rules
    (implemented).** Pros: uses the experimental routes the owner chose;
    the model and OpenCode both refuse another tab's tools; children inherit
    the rules. Cons: the credential is held by a server every session of
    the environment's 2.x process could name; a tool name carries a 12-hex
    server id.
  - **Disconnect other tabs' servers around each turn.** Cons: two tabs run
    concurrently in one environment; the window cannot be closed.
  - **A 2.x plugin serving the tools natively.** Rejected by owner decision 2.
  - Recommendation: the first.
- **Where a workflow session's line is recorded.**
  - **A small backend store keyed by environment and provider session id
    (implemented).** Pros: one write at creation covers every workflow
    (pipelines, Multi Review, graphs) without a field in each of their
    records and contract domains; survives restarts; read by the
    interactive router too. Cons: a new store; a full row (4,096) keeps new
    sessions on 1.x.
  - **A field on each caller's record (`PipelineSession`, Multi Review and
    graph branch records).** Pros: the fact lives beside the session it
    describes. Cons: three contract domains, and every re-registration site
    (about ten) would have to pass it; one missed site reads a 2.x session
    on 1.x, which reads it as missing.
  - **Encode the line in the provider session id.** Cons: every router
    member, and every other worker's new one, would have to strip it.
  - Recommendation: the store.
- **Which workflows move now.**
  - **Those with a policy that settles approvals (implemented).** A 2.x
    session has no interaction surface yet (phase 4), so an unattended ask
    would park forever; the host default policy for workflow origins is
    `auto-approve`, so pipelines and reviews do move. Pros: honest. Cons: an
    environment whose policy asks keeps 1.x until phase 4 lands.
  - **All of them.** Cons: a parked approval stalls the workflow.
  - Recommendation: the first; lift the `ask` condition with the
    interaction cards.
- **Coordinators.** Not moved. A coordinator needs the `plan` agent pinned per
  prompt, its research MCP server, the read-only policy honoured as process
  authority across restarts, and `synchronizeSessionPolicy`, none of which a
  2.x session does yet; `coordinator-providers.ts` is unchanged, and no
  `enforced` tier is claimed for 2.x.
- **Graph describe, goal verifier and suborks.** Not moved: they build their
  own `GraphAgentProviders` without `openCode2Workflow`. They need nothing
  missing; adding the dependency in `index.ts` moves them.
- **Sub-agents during a result turn.** A child created during a result turn
  inherits that turn's grant and keeps it after the turn. The broker still
  refuses its tools once the attempt's capability is consumed, so this is
  left as is rather than denying sub-agents on every result turn (1.x does
  not either).

Evidence: unit tests (`permissions.test.ts`, `workflow-results.test.ts`,
`routing-workflow.test.ts`, `native-agent-opencode-protocol.test.ts`,
`storage-opencode2-sessions.test.ts`, `build-pipeline-provider.test.ts`,
`native-agent-service-opencode-protocol.test.ts`) and
`opencode2-mcp.live.test.ts` against the real 2.2.6 binary with a scripted
model: a tab's MCP server is called by its own session with its own bearer,
another session (and its sub-agent) is told the tool does not exist and the
server sees no call; a result turn submits through its own tool, another
kind's tool is not offered, and after the turn the same call is refused; a
structured-output turn returns its parsed value; a read-only turn neither
writes a file nor runs `touch`, and the next ordinary turn writes.

Real stack, 2026-11-09, throwaway profile `oc2-w2-mcp` (`dev:test --fixture
--agent-platforms opencode --no-agent-credentials`, since stopped and reset):
the setting was turned on in Settings → OpenCode; with no tab opened, `ork
review launch` on a local fixture environment with an OpenCode reviewer and
review model (OpenCode's own default model) started the environment's 2.x
server (`host-server.ready`), recorded the preparation, reviewer and
consolidation sessions in `opencode2-sessions`, and finished at "Consolidated
report ready" with one P1 finding on the planted bug. Not checked live: a
build pipeline or graph run on 2.x, and which result transport (tool or
structured output) each Multi Review step used.

### Task 9: HTTP API, not ACP

Chose the HTTP API. ACP was the cheaper route and would have closed most of the
gate, but it cannot steer (see task 9), and steering is the owner's one hard
requirement.

### Owner decisions for parity (2026-11-09)

The owner chose every recommended option:

1. **Permissions offer Allow once / Deny only.** The provider never sends
   `always`, because it would save a rule in OpenCode's own database that
   applies to every later session and that Orkestrator cannot list or
   remove. This is the same stance as Codex exec-policy amendments.
   Orkestrator's own permission rules (0723) still apply.
2. **Orkestrator's tools reach 2.x through its per-session MCP routes**
   (`PUT /api/experimental/mcp/:server`, connect/disconnect). These are the
   per-tab agent MCP, the workflow-result tool and structured output, and the
   user's MCP servers. The exact pin plus a live test guard the experimental
   routes on every bump. The alternative, native tools in the 2.x plugin, was
   rejected: it would be a second implementation of every tool.
3. **One Orkestrator sign-in updates both lines.** It writes 1.x's `auth.json`
   (as today) and 2.x's `/api/credential` on the 2.x server.
4. **The same preview switch moves pipelines, Multi Review, graphs and
   coordinators** once 2.x can serve them. There is one switch, with one
   meaning: new OpenCode work uses 2.x.
5. **Nothing is pushed yet.** Everything stays on one local branch
   (`upgrade-opencode-602d9d93f8a6-r1`) until the owner says so.

### Task 5 and 6: container server and GitHub-token plugin (2026-11-09)

Branch `opencode2-containers`, from `862789fcd`. A container environment
whose image runs 2.x now takes OpenCode 2.x sessions under the same preview
switch as a local one.

What exists now:

- **Which containers.** `containerRunsOpenCode2`
  (`opencode2-container-server.ts`): the runtime's image manifest lists a 2.x
  `agents.opencode2`, and the container (its egress gateway, when it has one)
  publishes container port 4102 (`HostConfig.PortBindings`, so a stopped
  container answers too). Both are read only after every other condition
  already says 2.x. Anything unreadable answers false, so an older image, or
  a container created before the port existed, stays on 1.x.
- **The server** (`opencode2/container-server.ts`, started by
  `startContainerOpenCode2Server`): `/home/node/.opencode/bin/opencode2 serve`
  on 4102 in `/workspace`; `OPENCODE_DB` is `opencode2.db` beside 1.x's on the
  persistent `opencode/db` mount (`/home/node/.local/share/opencode/opencode2.db`
  without the mount, never `opencode.db`); `OPENCODE_CONFIG_DIR` is
  `/home/node/.config/orkestrator-opencode2`, holding only the two plugins;
  `OPENCODE_DISABLE_AUTOUPDATE=1`; `OPENCODE_FLAGS` as on the host; log
  `/tmp/opencode2-serve.log`. The password reaches the container on stdin
  only: to root's `/run/orkestrator-bridge/opencode2-token` and, through the
  start secrets, to the server alone (`boundedLaunchWithPrivateEnv`). Ready on
  `/api/info`, then one `GET /api/session/active` in `/workspace` loads the
  plugins. A server that answers with the persisted password and was started
  with the current plugins (a fingerprint file) is reused, also across a
  backend restart; anything else listening on 4102 is replaced. Starts share
  the container's OpenCode bridge-operation queue and sync the OpenCode login
  first, because 2.x imports `auth.json` once, on its first start.
- **Credential plugin, container form.** `buildOpenCode2CredentialPluginSource({
  hardened: "refuse-tools" })` also marks the server non-dumpable with
  `prctl(PR_SET_DUMPABLE, 0)` through `bun:ffi`, as the 1.x plugin does, and
  registers a `tool.execute.before` hook that refuses every tool when it
  cannot. Removing the variable alone does not change `/proc/<pid>/environ`.
- **GitHub-token plugin.** `buildOpenCode2GitHubEnvironmentPluginSource`: a
  `{ id, setup }` directory plugin whose `shell.hook("create.before")` reads
  `/tmp/orkestrator-ai/github-token` per shell and sets `GITHUB_TOKEN` and
  `GH_TOKEN`; a missing or empty file adds nothing. The start script unsets
  both, `GITHUB_PERSONAL_ACCESS_TOKEN` and 1.x's password variables, as 1.x's
  does.
- **Routing.** `openCode2EnvironmentServer` sends a container environment to
  the in-container server and everything else to the host one;
  `NativeAgentServiceOptions.openCode2InContainer` feeds the selection.
  Observers never start a server: a known one is re-checked at most every
  10 s, and one this backend did not start is adopted through its persisted
  password at most every 15 s; a server that stopped answering reads as none.
- **Shared plumbing.** Port 4102 is published on every new container
  (directly or through the egress gateway, `ORKESTRATOR_INGRESS_PORTS`
  included) and refused as a preview target; the legacy replacement copy
  carries `opencode2.db*`; `PROVIDER_STATE_TRACED_TOOLCHAINS` traces
  `opencode2` 2.2.6 and the layout test compares it with the pin.

Decisions:

- **Where the 2.x database lives.**
  - **A second file in the existing `opencode/db` sub-directory
    (implemented).** Pros: no new mount, so storage sets initialized before
    2.x (which create only the sub-directories they knew) mount unchanged;
    the preserving rebuild already copies the directory; 1.x never opens it.
    Cons: one mount holds both lines' databases; the layout entry describes
    two files.
  - **A new `PROVIDER_STATE_LAYOUT` entry.** Pros: one path per database.
    Cons: `volume-subpath` fails when the sub-directory is missing, so every
    existing storage set would need a migration before its next start.
  - Recommendation: the shared sub-directory.
- **Which credential modes 2.x accepts.**
  - **Root credential file only; `token-file` refused (implemented).** Pros:
    the password is never in a `node`-readable file; every image that carries
    `opencode2` has `bridge-credential` and `bridge-launch`. Cons: none in
    practice; the refusal exists for a hand-built image.
  - **Mirror 1.x's three modes.** Cons: a `node`-readable password file for a
    case that cannot occur with a supported image.
  - Recommendation: root only.
- **GitHub-token plugin on the host.**
  - **None (implemented).** 1.x has no GitHub plugin on the host either:
    `buildOpenCodeGitHubEnvironmentPluginSource` is written only into
    containers, and host shells inherit the user's own environment and `gh`
    login. Pros: same behaviour as 1.x on both sides. Cons: none.
  - **Write it into the host config directory.** Cons: there is no managed
    token file on the host to read, so it would do nothing.
  - Recommendation: none; the plugin builder takes a file path should a
    host token file ever exist.
- **What the 1.x stop command does to the 2.x server.**
  - **Nothing (implemented).** A container stop ends both. Pros: the 1.x
    stop is used for 1.x restarts and account changes, and stopping 2.x there
    would end a 2.x turn for an unrelated reason; 2.x does not re-read
    `auth.json` anyway. Cons: no explicit command stops 2.x alone (nothing
    needs one yet).
  - **Stop both, as the host does.** Cons: the reasons above.
  - Recommendation: nothing.
- **Network allowlist.** Read at `v2.2.6` (`packages/core/src`,
  `packages/cli/src`, `packages/util/src`). No change: OpenCode's own Zen and
  Go inference stay under `opencode.ai` (`/inference/...`) and its console is
  `opencode.ai/console`, both covered by the existing `opencode.ai` entry.
  The model catalogue refreshes from `models.opencode.ai`, a new exact name
  the egress filter refuses; 2.x then uses its bundled snapshot and logs the
  failed refresh (`ModelsDev.refresh` ignores the error), as 1.x does with
  its own `models.dev`, which is not listed either. A plugin package named in
  a config is installed from npm (`Npm.add`), which `registry.npmjs.org` in
  the default list already covers, as for 1.x. Add `models.opencode.ai` only
  if a fresh catalogue in restricted containers becomes a requirement.

Evidence:

- Unit: `opencode2/container-server.test.ts` (script, plugins, image and
  port checks), `opencode2/server.test.ts` (both plugin forms run against a
  stand-in context, including the Linux refusal), `tests/opencode2-container-server.test.ts`
  (fake Docker: password only on stdin and in root's file, reuse, refused
  `token-file`, missing port, adoption and its rate limit, routing,
  `containerRunsOpenCode2`), selection tests for containers, and the layout,
  replacement and preview tests.
- Live against the real 2.2.6 binary (macOS arm64,
  `opencode2-container-plugins.live.test.ts`): with the container plugin set
  and a 1.x plugin file in the shared config directory, the agent's shell saw
  no password and no token, then, after a fake token was written while the
  server ran, `GH_TOKEN` and `GITHUB_TOKEN` of the right length and still no
  password.
- Real stack, 2026-11-09, throwaway profile `oc2c-a612` (`dev:test --fixture
  --fixture-environments local,container --agent-platforms opencode
  --no-agent-credentials`, image built from this branch; since stopped and
  reset, its dev image removed). With the switch on, `session start --agent
  opencode` in `fixture-container` ran on the in-container 2.x server (the
  transcript shows 2.x's `shell` tool and message ids; OpenCode's free
  default model). Inside the container: `opencode serve` on 4096 and
  `opencode2 serve` on 4102 side by side; `/proc/<pid>/environ` of the 2.x
  server denied to `node` (so `prctl` through `bun:ffi` works in the Linux
  binary); `opencode2.db` beside `opencode.db` on the mounted
  `orkestrator-db`; both plugins in the config directory. The agent's shell
  printed `PW= SPW=`, and after a fake token was written to the managed file
  `GH=SET GT=SET LEN=38 PW=`. After `dev:stop` and a fresh `dev:test`, a
  follow-up prompt answered from the same 2.x process (same pid), so the
  restarted backend adopted it. `docker/tests/final-image-smoke.sh` passed on
  that image.

Not checked live: a container rebuild carrying `opencode2.db` across (the copy
plan is unit-tested), a gateway-less (`ORKESTRATOR_EGRESS=in-container`)
runtime, Linux amd64, and the inactive-environment path for a running 2.x
turn in a container. Both lines also share the data directory's
`snapshot/<project>/<worktree hash>` git directory (the same layout in 1.19.5
and 2.2.6), on the host as in containers; no conflict was seen, but
concurrent snapshots from both lines were not exercised.

## Related

- [0005-mid-turn-steer-and-interrupt.md](0005-mid-turn-steer-and-interrupt.md) (OpenCode
  steer is blocked on this).
- [0039-mcp-management.md](../mcp/0039-mcp-management.md) (`POST /mcp` →
  `PUT /api/experimental/mcp/:server`, V1 config keys).
- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md)
  (saved rules).
- [0006-session-titles-and-history.md](0006-session-titles-and-history.md) (staged
  revert).
- [agent-engines.md](../../architecture/agent-engines.md) "OpenCode" and
  "Maintaining the OpenCode integration";
  [upgrade-agents.md](../../development/upgrade-agents.md) (the OpenCode bump
  runbook).
- Upstream references (branch `v2`, tag `v2.0.18`):
  - [Session specification](https://github.com/anomalyco/opencode/blob/v2.0.18/specs/v2/session.md)
  - [Event stream architecture](https://github.com/anomalyco/opencode/blob/v2.0.18/specs/v2/event-stream-architecture.md)
  - [V1 migration guide](https://github.com/anomalyco/opencode/blob/v2.0.18/services/www/src/docs/content/migrate-v1.mdx)
  - [Prompt input schema](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/schema/src/prompt-input.ts)
  - [Session HTTP handlers](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/server/src/handlers/session.ts)
  - [V1 data migration](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/core/src/database/v1-migration.bun.ts)

## Replaces

- The previous `docs/todo/opencode-v2.md` (rewritten in place: durable content
  carried over, file references corrected)
- `docs/plans/sdk-coverage/13-opencode-v1-streaming-and-cleanup.md` (done; its
  out-of-scope list is this file; the inactive-path browser run is in
  [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md))
- `docs/plans/sdk-coverage/00-index.md` ("Deliberately not planned: OpenCode v2
  session protocol")
- `docs/plans/sdk-coverage/05-mid-turn-control-steer-and-interrupt.md`
  ("OpenCode steering" out of scope)
- `docs/plans/sdk-coverage-2026-09-06.md` (OpenCode §5 introduction, §5.6,
  §5.9; Tier 3 row 27)
