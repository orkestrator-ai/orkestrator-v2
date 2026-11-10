# OpenCode 2.x migration

Checked against `main` at `8598abfe4` (2026-11-08).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

Status rechecked 2026-10-30 against `main` at `cd7bbe3e5`, and task 2 again on 2026-11-06 against `main` at `ee2cc8423` (2.2.5); see "Assumptions and decisions" and [1031](1031-provider-upgrade-2026-11-06.md) task 7. Upstream rechecked again on 2026-11-08 against `main` at `8598abfe4` (2.2.6), and task 9 added; see "Upstream recheck at 2.2.6".

1. **Upstream recheck**: rerun the recheck procedure against the current 1.x and 2.x releases (the "Needs verification" item). Status: done (2026-10-30, against 2.2.2 and the 1.19.4 pin; see "Upstream recheck at 2.2.2").
2. **Readiness gate and start decision**: decide when the 2.x work may start, using the gate's open conditions. Status: done for the start, rechecked 2026-11-10 against `main` at `04639b12b`; making 2.x the default is task 7 (trigger decided; still blocked at 2.2.2 by storage policy, per-prompt model/agent/tools and structured output, runtime-context gaps, stale-turn guard, bounded inbox and experimental MCP endpoints; rechecked at the 1.19.5 upgrade on 2026-10-30, still 2.2.2 and unchanged, see [1020](1020-provider-upgrade-2026-10-30.md) task 8; rechecked 2026-11-06 against 2.2.5, still closed, see [1031](1031-provider-upgrade-2026-11-06.md) task 7; rechecked 2026-11-08 against 2.2.6, unchanged. On 2026-11-08 the owner asked to move: steering is required and undo may be dropped. The 2.x provider was then built with the mitigations under "Task 2: owner decision" and merged as an opt-in preview in #2009 on 2026-11-09, so the start decision is settled; no explicit owner acceptance of those mitigations is recorded, and it belongs to the decision to make 2.x the default (task 7, phase 6)).
3. **Legacy 1.x session policy**: keep, migrate or retire existing 1.x sessions when 2.x arrives (open question 1, code item 5). Status: done for the opt-in preview (keep existing sessions on a pinned 1.x binary with its own database; the persisted marker and per-session routing are built under task 5, phase 3). Qualification and the default switch remain task 7.
4. **Losses to decide**: rebuild, capability-gate or drop each of the eight listed losses (code item 3, open question 2). Status: done for the opt-in preview (share dropped with 1.19.1; the remaining rebuilds and capability gates are recorded under task 5, phases 4 and 5, including session features). Live qualification remains task 7.
5. **`opencode2` provider**: a second provider with its own binary pin, `OPENCODE_DB`, `@opencode/client`, persisted protocol marker, snapshot-plus-hints projection and native steer/queue (code items 1, 2 and 4). Status: in progress (phase 1 of the "Build plan" done 2026-11-08; phase 2's toolchain half, the `opencode2` 2.2.6 pin, done 2026-11-08; phase 3 done for host environments on 2026-11-08: the opt-in setting, the session marker, the host 2.x server and per-session routing, with steer on for 2.x sessions; containers done on 2026-11-09 for images that carry `opencode2` (see "Task 5 and 6: container server and GitHub-token plugin"); phase 4 (interaction cards, full transcript, paging, usage) done on 2026-11-09, see "Task 5: phase 4 interactions, transcript and usage"; on 2026-11-09 phase 5's MCP, workflow results, structured output, read-only turns and the move of build pipelines, Multi Review and graph agent nodes under the same switch, see "Task 5: phase 5 MCP, results, read-only turns and workflows"; and on 2026-11-09 phase 5's session features (sign-in on both lines, the 2.x catalogue and effort, attachments, slash commands, Plan/Build, compact, undo/redo, fork, resume, titles, to-dos), see "Task 5: phase 5 session features"; on 2026-11-09 workflows in containers, graph describe/goal verifier/subork sessions, and artifact grants, the design connection and worker mail on 2.x turns, see "Task 5: phase 5 workflows in containers, describe/verifier/subork sessions and per-turn connections"; on 2026-11-09 the user's global OpenCode configuration (MCP servers above all) on host and container 2.x servers, see "Task 5: phase 5 the user's global configuration"; on 2026-11-09 coordinators under the same switch, on their own 2.x server with the read-only policy as process authority, tier left `provider-configured`, see "Task 5: coordinators on 2.x"; on 2026-11-10 archive from the resume picker for 2.x conversations, see "Task 5: archive from the resume picker (2026-11-10)"; open: a live-model run of the coordinator suite on 2.x, and phase 6 (qualification and default); see "Task 5: phase 3 routing and preview setting").
6. **Changes that must ship with the first 2.x pin**: health probe on `/api/info` rejecting HTML, isolated `OPENCODE_DB` on host and container, GitHub-token plugin ported to `@opencode/plugin`, provider sign-in moved to `/api/credential`, live tests off `serve --pure`. Status: partly done (`checkHttpHealth` refuses HTML since 2026-10-30; the compatibility probe no longer uses `--pure`; since 2026-11-08 the 1.x host falls back to its own `OPENCODE_DB` when the shared database has no `session` table; the 2.x binary is pinned from the npm platform tarballs and launched with its own `OPENCODE_DB`, `/api/info` health and a 2.x credential plugin for opted-in host sessions since 2026-11-08; since 2026-11-09 the container 2.x server, with its own `opencode2.db` on the persistent mount, the GitHub-token plugin ported to the 2.x shape, and sign-in mirrored into 2.x's credential store). Done.
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

This file began as the deferred checkpoint for moving from the OpenCode 1.x
line to OpenCode 2.x. Since #2009 (2026-11-09) 2.x runs as an opt-in preview:
a separate `opencode2` provider beside the 1.x one, which stays the default
and keeps its own binary and SDK pins (task 5; qualification and the default
switch are task 7). A 2.x server has no legacy HTTP API, so the move is a
rewrite of the backend OpenCode provider rather than a version bump. Upstream
evidence was last refreshed on 2026-11-08 against OpenCode `v2.2.6` (see
"Upstream recheck at 2.2.6"; before that 2026-10-30 against `v2.2.2` and
2026-09-27 against `v2.0.18`). The 1.x line was rechecked at `1.19.0` on
2026-10-11/13 (#964), moved to `1.19.4` on 2026-10-23 and is pinned at
`1.19.5` (see Current state).

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
  (`/home/node/.opencode/bin/opencode2`, `OPENCODE2_CLI_PATH`). Since #2009
  (2026-11-09) the opt-in preview launches it for opted-in sessions (task 5);
  `opencode2` is not an agent platform. The bump procedure
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
     agent nodes follow the preview switch. **Done on 2026-11-09** (branch
     `opencode2-workflows-rest`): workflows in containers whose image runs
     2.x, graph describe, goal verifier and subork sessions, and artifact
     grants, the design connection and worker mail on 2.x turns (see "Task
     5: phase 5 workflows in containers, describe/verifier/subork sessions
     and per-turn connections"). Coordinators: done on 2026-11-09 (see "Task 5: coordinators on 2.x").
   - **The user's global configuration: done on 2026-11-09, host and
     container** (branch `opencode2-globalcfg-flake`; see "Task 5: phase 5
     the user's global configuration"). Orkestrator's 2.x config directory
     mirrors `~/.config/opencode` read-only and without plugins
     (`opencode2/user-config.ts`), so a 2.x server sees the same MCP servers,
     providers, agents, commands, skills and `AGENTS.md` a 1.x server does;
     a policy that selects its user MCP servers denies the others on 2.x as on
     1.x.
   - **Session features: done for host sessions on 2026-11-09** (branch
     `opencode2-session-features`; see "Task 5: phase 5 session features").
     Sign-in on both lines (each 1.x change mirrored into the 2.x database),
     the 2.x model catalogue with variants as effort, attachments, slash
     commands, Plan/Build, compact, undo/redo by staged revert, fork, the
     resume list, titles and the to-do count. A 2.x tab now offers all of
     them. Archiving from the resume picker followed on 2026-11-10 (see
     "Task 5: archive from the resume picker (2026-11-10)"). Open: a
     command's dispatch evidence (2.x records no metadata for a command); the
     container server followed on 2026-11-09.
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
  - **Lifted on 2026-11-09 at integration.** Phase 4's cards reach a
    workflow through the provider's `interactions`, as on 1.x, so a policy
    that asks (or none) now takes 2.x too; only the coordinator's read-only
    policy keeps 1.x (`newOpenCodeWorkflowSessionProtocol`).
- **Coordinators.** Not moved. A coordinator needs the `plan` agent pinned per
  prompt, its research MCP server, the read-only policy honoured as process
  authority across restarts, and `synchronizeSessionPolicy`, none of which a
  2.x session does yet; `coordinator-providers.ts` is unchanged, and no
  `enforced` tier is claimed for 2.x. (Moved on 2026-11-09; see "Task 5:
  coordinators on 2.x".)
- **Graph describe, goal verifier and suborks.** Not moved: they build their
  own `GraphAgentProviders` without `openCode2Workflow`. They need nothing
  missing; adding the dependency in `index.ts` moves them. **Moved on
  2026-11-09**; see "Task 5: phase 5 workflows in containers,
  describe/verifier/subork sessions and per-turn connections".
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

### Task 5: phase 5 session features (2026-11-09)

Branch `opencode2-session-features`, from `862789fcd`. The 2.x provider
delegates these to a collaborator, `opencode2/features.ts`, with one module
per feature (`models.ts`, `attachments.ts`, `commands.ts`, `revert.ts`,
`sessions.ts`, `credentials.ts`); `opencode2-credential-sync.ts` mirrors
sign-ins. `OPENCODE2_CAPABILITY_LIMITS` now removes only `share` and
`rewindMessages`, which OpenCode's table does not offer anyway, so a 2.x tab
offers compact, undo, redo, fork, attachments and slash commands.

Facts observed on 2.2.6 (scripted model, isolated fixture):

- `POST /api/session/:id/model` and `/agent` answer 204 for a model, variant
  or agent the server does not know; a switch with no variant sets `default`.
- `GET /api/model` lists only models the server can serve (a provider with no
  credential has none), each with its `settings`, API key included, and its
  `variants`. `GET /api/provider` reports a provider enabled by a credential
  as `activation: "auto"`.
- The server reads a `file://` prompt file itself at admission, stores the
  bytes on the user row and derives the media type from the bytes: text sent
  as `data:image/png` reached the model as text.
- `POST /command` answers 204 within milliseconds, once the command's prompt
  is admitted. The command's user row is the expanded template and carries no
  metadata. An unknown name is 404 `CommandNotFoundError`. Built-ins are
  `init`, `review` and `goal`.
- `revert/stage` restores the files changed after the boundary (2.x's
  snapshots need the directory to be a git worktree) and keeps every row;
  `DELETE revert` puts them back; the next prompt deletes the rows from the
  boundary on. All three answer 409 while a run is active.
- `fork {}` copies the whole history, `fork { before }` the part before a
  message; copied rows get ids ending `_1`, `_2`, … `_10`, which do not sort.
- A credential written through `/api/credential` connects its provider at
  once, and deleting it disconnects it, without a restart.

Decisions:

- **How a sign-in reaches 2.x.**
  - **Mirror each 1.x change into the 2.x database, reading that provider's
    new `auth.json` entry and mapping it the way 2.x's own import does
    (implemented).** Pros: one sign-in flow (API key, OAuth, sign-out) for
    both lines, as decision 3 asks; OAuth needs no second browser round
    trip; the mapping is upstream's own. Cons: Orkestrator reads one
    credential from `auth.json` (in memory only, never logged); a new 2.x
    method id would need the mapping updated.
  - **Run each sign-in against both servers' own routes.** Pros: no file
    read. Cons: OAuth would ask the user to approve twice, and 2.x's
    integration methods do not match 1.x's method indexes.
  - Recommendation: the mirror. No 2.x database yet means nothing to do (its
    first start imports `auth.json`). A failed mirror is reported to the user
    with 1.x already holding the change; a retry repeats both. A running
    host 2.x server is used for the write, else a private one on the same
    database is started and stopped.
- **The 2.x catalogue and validation.**
  - **The session's composer comes from its own 2.x server; session-free
    reads (launch dialogs, defaults) stay on 1.x (implemented).** Pros: the
    picker offers what the 2.x server can serve, with its variants; launch
    surfaces never start a 2.x server. Cons: a launch dialog can offer a
    model the 2.x server cannot serve; the first send then refuses it with a
    clear message.
  - **A 2.x catalogue everywhere while the setting is on.** Cons: starts a
    2.x server from session-free reads.
  - Recommendation: per session. Selections are validated against every
    servable model (the allowlist shapes the picker, never dispatch), because
    2.x accepts anything with 204.
- **Slash commands.** Reused the 1.x registry and resolver
  (`OpenCodeCommandRegistry`, `resolveOpenCodeCommandDispatch`) with a 2.x
  loader, rather than a copy: the rules are identical, and a copy would
  drift. Command ids share the `opencode:` prefix; a session never changes
  line, so a 1.x selection never reaches a 2.x registry. Refresh re-reads the
  list (`reread`); 2.x has no idle-gated reload here.
- **Undo and Redo.** Undo stages a revert at the newest user row still
  showing (or the row the UI names); Redo clears the whole staged revert, as
  1.x `unrevert` does. The transcript hides the boundary and every later row
  by position, not by id (forked ids do not sort). `messages()` filters;
  dispatch evidence still reads every row.
- **Which line a resumed or forked session takes after a restart.**
  - **Resume-list rows carry `opencode2:<id>`, the router remembers forks,
    and adoption records `openCodeProtocol` from a new provider member,
    `sessionProtocol` (implemented).** Pros: survives a restart once
    adopted; no guessing between servers. Cons: a fork whose tab is not
    opened before a backend restart is read on 1.x (it is still in the
    resume list under its prefixed id).
  - **Ask both servers for an unknown session.** Cons: starts a 2.x server
    for every 1.x session (rejected in phase 3).
  - Recommendation: the prefix and the recorded marker.
- **Sign-in status.** `authStatus` takes an optional session id, and the
  router answers a 2.x session from its server's `/api/provider`, without
  starting one. Every other provider ignores the argument.
- **Attach control.** The renderer reads attachments from the session's
  projection (`projection.capabilities`, the platform table narrowed per
  session), falling back to the platform table before the first projection.
- **Plan/Build.** The execution profile is switched with `POST /agent` before
  the prompt, only when it changes; 2.x's primary, visible agents are the
  profiles. A first switch compares the session's own agent, so a resumed
  session does not gain a needless `agent-switched` row.

Not done: archiving from the resume picker (OpenCode's platform table had no
`archive` action; the provider implemented it for `opencode2:` ids; done on
2026-11-10, see "Task 5: archive from the resume picker (2026-11-10)"), compact
with another model or instructions (2.x has neither), a container 2.x
server, and command dispatch evidence (an ambiguous command reads `unknown`
and is never re-sent).

### Task 5: phase 5 workflows in containers, describe/verifier/subork sessions and per-turn connections (2026-11-09)

Branch `opencode2-workflows-rest`, from `5ed139cfc` (the tip of
`upgrade-opencode-602d9d93f8a6-r1`). Owner decisions 2 and 4 applied.

What exists now:

- **Workflows in containers.** `newOpenCodeWorkflowSessionProtocol` takes a
  `containerRunsV2` argument, and `openCodeWorkflowRoutingDependencies` an
  `inContainer` option, wired in `index.ts` to the same
  `containerRunsOpenCode2` check the interactive path uses. A workflow
  session in a container environment takes 2.x when the setting says `v2`,
  the record has capacity, the policy is not the coordinator's, and only
  then the image runs 2.x (read last, so a 1.x answer never reads Docker; an
  unreadable answer is 1.x). The 2.x connection is the in-container server,
  through the `openCode2EnvironmentServer` routing that already served
  interactive tabs.
- **Graph describe, goal verifier and subork sessions** get
  `openCode2Workflow` in their `GraphAgentProviders` dependencies, so they
  follow the switch like graph agent nodes. They needed nothing else: all
  three create reviewer sessions with the environment's `automated-review`
  policy and run read-only turns that submit through the workflow-result
  tool (or structured output), which 2.x already serves. A subork's result
  turn denies `orkestrator_*` apart from its own result tools (1.x's rule,
  translated), which on 2.x also covers the tab, design and artifact
  servers, so its depth stays 1. The read-only tier stays
  `provider-configured` (session rules), as on 1.x.
- **Per-turn connections** (`opencode2/turn-connections.ts`). 1.x carries
  the artifact grant, a pipeline worker's mail capability and the tab's
  mailbox as trusted `system` text on its environment-wide connection. A 2.x
  prompt has no `system` field and a 2.x server has no environment-wide
  Orkestrator connection, so the 2.x provider turns them into connections,
  the way the HTTP bridges carry them:
  - a result turn (the broker connection) with an `artifactGrant` gets the
    session's own artifact-only server, `orkestrator_artifacts_<id>` at
    `/artifact-mcp`, authenticated by the grant (the bridges'
    `orkestrator-artifacts`); a turn without a grant removes it;
  - a tab-scoped connection that says `design` gets the session's own
    `orkestrator_design_<id>` at `/design-mcp` with the same credential (the
    bridges' `orkestrator-design`); a turn without it removes it; the broker
    never gets one (design refuses workflow credentials);
  - a pipeline worker turn with `workerMail` and no connection gets the
    worker mailbox's own scoped connection (`AgentToolsServer.connection(…,
    tabId)`, what a bridge worker gets), registered as the session's tab
    server. It is issued only for the mailbox the turn's signed capability
    names (`authenticatePipelineWorkerMailCapability`), in the provider's
    environment and project; the capability itself is never sent;
  - `tabMail`: an interactive 2.x tab already connects with its own
    tab-scoped credential, which names the mailbox, so nothing is added.

  Session rules deny every session's `orkestrator_design_*` and
  `orkestrator_artifacts_*` servers and allow the session's own, as for the
  tab server; closing a session removes all three. The per-kind bound on
  registered servers is 256 each.

Decisions:

- **How the per-turn facts reach a 2.x turn.**
  - **Per-session MCP servers built from the options callers already pass,
    inside the 2.x provider (implemented).** Pros: owner decision 2's
    mechanism; no caller changes (pipelines, Multi Review, graphs,
    feature planning and the native service pass the same options to both
    lines); the grant and capability never become model-visible text.
    Cons: the provider needs one backend dependency (the worker mailbox
    resolver) that it receives through the routing dependencies.
  - **Make each caller line-aware and pass bridge-style connections for a
    2.x session.** Pros: the provider stays generic. Cons: about eight call
    sites (`build-pipeline-context.ts`, the review fan-outs, the agent
    branch runner, Multi Review, feature planning) would each need an async
    line lookup before the dispatch window.
  - **Put the instructions into the prompt text.** Cons: the grant and
    capability would be stored on the user row and shown in the transcript,
    which the contract forbids.
  - Recommendation: the first.
- **Which turns get the artifact grant.**
  - **Only turns whose connection is the result broker, as on the bridges
    (implemented).** A tab's or worker's tab-scoped connection already
    carries artifact authority (`resolveArtifactCaller`'s tab path). Pros:
    no duplicate artifact tools in one session; identical to the bridges.
    Cons: on a pipeline worker turn without a result tool, artifacts are
    owned by the worker mailbox's conversation
    (`env-<env>:pipeline-worker:<key>`), not the stage session's key, which
    is where 1.x's grant puts them. The bridges have the same gap.
  - **Every turn with a grant, beside the tab connection.** Pros: 1.x's
    ownership on worker turns. Cons: the session would list two
    `create_artifact` tools with different owners, and the model picks.
  - Recommendation: the first; fix the ownership for bridges and 2.x
    together if it matters (a worker connection whose artifact calls are
    owned by the stage session).
- **Worker mailbox issuance.**
  - **Verify the signed capability, then issue (implemented).** Pros: a
    turn can only be handed the mailbox the backend signed for it, even
    though `workerMail` comes from backend code. Cons: one HMAC per worker
    turn.
  - **Trust `workerMail.tabId`.** Cons: no defence in depth.
  - Recommendation: verify.
- **Kept on 1.x.** Coordinators (worker 3's area) and containers whose image
  does not carry `opencode2` or publish port 4102. Nothing in graph
  describe, goal verifiers or suborks needed to stay on 1.x.

Evidence:

- Unit: `native-agent-opencode-protocol.test.ts` (container selection, image
  read last, unreadable image, capacity, coordinator policy, the mailbox
  dependency), `opencode2/turn-connections.test.ts` (each option's
  conversion and the capability check), `opencode2/workflow-connections.test.ts`
  (against the fake server: the artifact server per result turn, replaced
  and removed; a subork result turn denying it; a tab's grant not
  registered; the design server and its removal; worker mailbox
  registration without the capability or grant reaching OpenCode),
  `opencode2/permissions.test.ts` (confinement of the new kinds),
  `graph-agent-providers-opencode2.test.ts` (a `GraphAgentProviders` with the
  dependency creates and records 2.x sessions, and leaves 1.x alone).
- Live against the real 2.2.6 binary with a scripted model
  (`opencode2-workflow-connections.live.test.ts`): a tab's design tool
  reached `/design-mcp` with the tab's bearer and was not offered to another
  session; a result turn's artifact tool reached `/artifact-mcp` with the
  grant as bearer, was not offered to another session, and was gone the next
  turn (and from `GET /api/mcp`); a worker turn's tab tool reached `/mcp` with
  the worker's own token, and neither the capability nor the grant appeared
  in any model input. The existing 2.x live files (MCP, routing, provider,
  interactions, features) still pass with the new isolation rules.

- Real stack, 2026-11-09, throwaway profile `oc2-wrest-7c1` (`dev:test
  --fixture --agent-platforms opencode --no-agent-credentials`, since stopped
  and reset): the switch turned on in Settings → OpenCode; an OpenCode tab
  in a local fixture environment ran on 2.x (OpenCode's free Big Pickle).
  `session goal set … --verifier opencode` ended `complete` with
  `verdict-passed`; the verifier ran as a 2.x session (labelled
  `Goal · Verifier`, with the reviewer marker, in the 2.x database) and was
  the one id recorded in `opencode2-sessions`. A `/subork ask opencode …`
  prompt then ran a subork on 2.x (`Subork · …` in the 2.x database,
  `resultTransport: "tool-v1"`, `certified`, answer delivered to the tab).
  The verifier's verdict said its shell was denied; whether the goal
  verifier passes `reviewShellPolicy` (so a reviewer's constrained shell
  applies) was not investigated.

Not checked live: a workflow in a container running 2.x (needs an image
built from this branch), graph describe on 2.x, a build pipeline worker
turn's mailbox through the real agent tools server, and artifact
publication end to end on 2.x.

### Task 5: phase 5 the user's global configuration (2026-11-09)

Branch `opencode2-globalcfg-flake`, from `5ed139cfc`. Code:
`opencode2/user-config.ts` (new), `opencode2/server.ts`,
`opencode2/container-server.ts`, `opencode2-host-server.ts`,
`opencode2-credential-sync.ts`, `opencode2/mcp.ts`, `opencode2/permissions.ts`,
`opencode2/provider.ts`.

How 2.2.6 resolves configuration (upstream `v2.2.6`,
`packages/util/src/global.ts`, `packages/core/src/config.ts`,
`config/discovery.ts`, `packages/cli/src/server-process.ts`):

- `OPENCODE_CONFIG_DIR` **replaces** the global directory (`Global.config`);
  on 1.x it only adds one. The global directory supplies `opencode.json` and
  `opencode.jsonc` (not `config.json`), the `agent(s)`/`mode(s)`,
  `command(s)`, `skill(s)` and `plugin(s)` directories, and `AGENTS.md`.
- Layers, lowest first: managed policies, integrations, well-known, the
  global directory, `OPENCODE_CONFIG` (an explicit file), project
  `opencode.json(c)` files, project `.opencode` directories,
  `OPENCODE_CONFIG_CONTENT`, managed settings. The project walk goes up to
  `/` with no stop, so `~/.opencode` and `~/opencode.json` are read as
  project layers for any worktree below the home directory.
- 2.x writes its global directory: `cli.json` (CLI configuration and its
  migration) and `opencode.jsonc` through `Config.update`.
- A malformed document is skipped with a warning, not fatal.
- Plugins: a `plugin`/`plugins` entry that names an npm package is installed
  (`npm.add`), and the plugin registry is held until pending installs
  settle. A module without `{ id, setup | effect }` fails to load with a
  warning (`PluginSupervisor`), which is how a 1.x plugin ends. A
  `plugins: ["-*"]` or `"-<id>"` entry unloads every plugin it matches
  except upstream's guarded internals, so it would unload Orkestrator's
  credential plugin.
- A configured MCP server's tools default to Code Mode: the model reaches
  them through `execute` as `tools["<server>"].<tool>(...)`, not as
  `<server>_<tool>`. A `deny` rule on `<server>_*` removes them from Code
  Mode's catalogue ("Unknown tool 'user-tools.user_echo'", observed live).

What was built:

- **The mirror.** Every 2.x start refreshes Orkestrator's 2.x config
  directory from `$XDG_CONFIG_HOME/opencode` (the directory the 1.x server
  reads): one merged `opencode.jsonc` from `config.json`, `opencode.json` and
  `opencode.jsonc` in 1.x's order, without `plugin`/`plugins`, relative
  `{file:...}` references rebased onto the user's directory; links to the
  user's `agent(s)`, `mode(s)`, `command(s)`, `skill(s)` and `AGENTS.md`.
  The backend's `OPENCODE_CONFIG`, when set, is mirrored the same way to
  `<data>/opencode2/opencode-config.jsonc` and passed in its place; it is
  never passed unmirrored. Nothing is written below the user's directory, a
  failed mirror never fails the start, and the mirror is owner-only.
- **Containers.** The start script mirrors the container's
  `~/.config/opencode` (the entrypoint's copy of the host's) the same way,
  running `mergeOpenCodeUserConfig`'s own source with the image's Bun; the
  plugin fingerprint covers the mirror script, so a server started before it
  is replaced on its next use.
- **MCP selection on 2.x.** A session created with a policy that selects its
  user MCP servers (`capabilityPolicy.userMcpServers`) lists the location's
  servers (`GET /api/mcp`) and adds 1.x's per-server rules
  (`openCodeUserMcpRules`) to its base; a list that cannot be read refuses
  the session, as on 1.x. Before the mirror only project servers reached a
  2.x session, and their selection was not applied either.

What a 2.x session loses against 1.x, from the user's own configuration:
1.x plugins (in the global `plugin(s)` directory or the `plugin` key) and
1.x custom tools (`tool/`), which 2.x does not run; a 2.x-native plugin in
the user's global directory, which the mirror does not link either; a
backend `OPENCODE_CONFIG_DIR`, which 2.x replaces with Orkestrator's (1.x
keeps it and goes without the credential plugin); and `~/.opencode` for a
worktree outside the home directory. Upstream issue #50286 (the 1.x normalization
overwriting a custom provider `baseURL`) applies to mirrored providers.

Evidence: `opencode2-user-config.live.test.ts` on the pinned 2.2.6 binary,
with an isolated `XDG_CONFIG_HOME` holding a fake `opencode.json` (a local
stdio MCP server, a 1.x npm `plugin` entry and `-*`), a `command/`
directory and a 1.x plugin file: `GET /api/mcp` lists the server as
connected, a session calls its tool through Code Mode, the shell still sees
no `OPENCODE_PASSWORD`, `/api/command` lists the user's command, the 1.x
plugin is never imported and the user's directory is byte-identical after;
a session whose policy selects no user server gets "Unknown tool" from Code
Mode. The control (the same files without the mirror) lists neither the
server nor the command once a project-level server and command have loaded.

Decisions:

- **How 2.x gets the user's global directory.**
  - **A read-only mirror in Orkestrator's config directory (recommended,
    built).** Pros: the credential plugin stays in the global directory;
    nothing writes to the user's directory; plugin entries can be
    withheld; precedence matches 1.x (global below `OPENCODE_CONFIG` and
    project). Cons: a copy of the user's files (API keys included) under
    Orkestrator's data directory, owner-only, beside the 2.x database that
    already holds the imported `auth.json`; refreshed per server start, not
    on every edit; one merged document instead of three.
  - **Point `OPENCODE_CONFIG_DIR` at `~/.config/opencode` and put the plugin
    elsewhere.** Pros: no copy, live edits. Cons: 2.x writes `cli.json` and
    `opencode.jsonc` there; the user's `plugins: ["-*"]` or a 1.x npm plugin
    reaches the server; there is no other place to load a plugin directory
    from without a project file.
  - **`OPENCODE_CONFIG` pointing at the user's `opencode.json`.** Pros: no
    copy, read-only, live. Cons: one file only (not `opencode.jsonc`, not
    `config.json`), no directories, the plugin entries pass through, and it
    displaces a backend `OPENCODE_CONFIG`.
- **What to do with the user's plugin entries.**
  - **Withhold every `plugin`/`plugins` entry and the plugin directories
    (recommended, built).** Pros: a 1.x npm plugin is never installed, a
    `-*` cannot unload the credential plugin, nothing of the user's runs in
    the 2.x server. Cons: a 2.x-native plugin the user configured globally
    does not load in Orkestrator's 2.x sessions.
  - **Pass them through.** Pros: 2.x-native plugins work. Cons: npm installs
    hold the plugin registry, and `-*` or `-orkestrator-credential` would put
    the server password back in the agent's shell.
- **When to refresh.**
  - **On every 2.x server start, host and container (recommended, built).**
    Pros: the same moment 1.x reads its user files (it keeps them for its
    lifetime), so the MCP settings page's "stop and start the environment"
    applies to both lines. A running host server also follows a refresh made
    by another environment's start, since it watches its config directory.
    Cons: an edit reaches a running 2.x server only at the next start
    anywhere on the host.
  - **Also on every MCP settings save.** Pros: live on 2.x. Cons: the apply
    pipeline would report `restart-required` for a change already applied,
    and a save would reconfigure every running host 2.x server mid-turn.
- **Enforce the MCP selection on 2.x in this change.**
  - **Yes, at session creation (recommended, built).** Pros: without it the
    mirror would hand global servers to sessions whose policy excludes them.
    Cons: servers added after creation are not denied, and a reviewer's
    read-only turn replaces
    the base rules (`openCode2TurnRules`), so its selection rules do not apply
    during that turn; see Not done.
  - **Leave it to the workflows work.** Pros: smaller change. Cons: a
    regression for graph nodes with an MCP selection the moment the mirror
    lands.

Not done: a reviewer's read-only turn on 2.x runs with the review rules in
place of the base, so a reviewer policy's user MCP selection is not applied
during that turn (carry the selection rules into `openCode2TurnRules`); the
container mirror was run with the host's Bun 1.4.4 against a temporary
directory, not inside a real container image; a backend
`OPENCODE_CONFIG_DIR` is not read by 2.x.

### Task 5: coordinators on 2.x (2026-11-09)

Branch `opencode2-coordinators`, from `5ed139cfc`. Owner decision 4 applied:
the preview switch now moves coordinators too. Living description:
[coordinator.md](../../architecture/coordinator.md#provider-qualification)
(the OpenCode 2 paragraph under "Provider qualification").

What exists now:

- **Routing.** A new coordinator session takes 2.x when the setting says
  `v2`, a 2.x host exists, and the request is exactly the trusted coordinator
  shape for a coordinator runtime (origin `coordinator`, owner the runtime's
  coordinator, `coordinator-read-only`); `newOpenCodeCoordinatorSessionProtocol`
  in `opencode2/coordinator.ts`, called first by
  `selectNewOpenCodeSessionProtocol`. Existing conversations keep 1.x.
- **Its own server.** `ensureOpenCode2HostServer` now serves a coordinator
  runtime id (bug reports stay refused): the project checkout, a separate
  configuration directory (`opencode2/coordinator-config`, credential plugin
  plus the coordinator guard), and the launch variables
  `ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only`,
  `ORKESTRATOR_COORDINATOR_PROTECTED_DATA_DIR`, the attachment root, the
  research setting and `OPENCODE_DISABLE_PROJECT_CONFIG=1`. The host record
  keeps the launch's policy and research (`coordinator` on
  `OpenCode2HostServerRecord`), the route connection carries it, and a
  changed research setting replaces the server once it is idle. It stops with
  the conversation's 1.x server, as every 2.x server does.
- **Guard plugin** (`opencode2/coordinator-plugin.ts`). Active only under the
  policy variable. A tool allowlist (read-only built-ins, search per the
  launch's research mode, the control tools by exact id, the launch's research
  servers by namespace) and the data-directory read check, ported from 1.x
  for 2.2.6's tool names (`read` takes `path`) and its
  `ctx.tool.hook("execute.before")` event, plus absolute `glob` patterns.
- **Provider authority** (`OpenCode2CoordinatorSessions`, and
  `OpenCode2TurnGrants`' new rule authority). On a coordinator's server the
  provider ignores a request's policy and a session's stored base and
  reviewer marker: create (as `plan`), resume, fork, policy synchronization
  and every turn write 1.x's coordinator rules, translated, and read them
  back; a write that does not persist refuses the turn. Every prompt runs as
  `plan` (read back), a selected provider command is refused, typed slash
  text goes as text, and the command catalogue is `unsupported`.
- **Tools.** The control credential is the one the conversation's 1.x server
  was launched with (`openCodeAgentTools.launchConnection`), registered as the
  location's `orkestrator` server before each turn (re-registered when it
  rotates). Research servers are registered once per server generation and
  allowed by exact id (`openCodeResearchToolIds`, shared with 1.x; at most
  256 ids).
- **`synchronizeSessionPolicy` for 2.x.** The router delegates; a
  coordinator's server restates its rules and refuses any other policy, an
  ordinary server records the policy as the session's base and restates.
- **Provider pruning.** The launch scan disposed every provider whose id has
  no environment row, so a coordinator's provider (and a bug report's) was
  disposed while an ensure still held it; the 2.x cold start made that
  visible (`OpenCode provider was disposed` on the first coordinator session,
  observed in the real-stack run). Runtime ids whose coordinator conversation
  or bug report still resolves now count as live
  (`native-agent-runtime-liveness.ts`).
- **Qualification.** `coordinator-providers.ts` is unchanged and OpenCode
  stays `provider-configured`; the reason in `capability-enforcement.ts` now
  says a coordinator under the preview runs without project configuration
  behind a server-side gate that is not yet qualified with a live model.

Decisions:

- **Where a coordinator's 2.x server gets its process authority.**
  - **A separate 2.x server per coordinator conversation, keyed by its runtime
    id, launched with the authority (implemented).** Pros: mirrors the 1.x
    coordinator server and every bridge; the policy, the data directory and
    project configuration off are process-wide facts that no request can
    change; the guard can refuse whatever the stored rules say; the existing
    stop, shutdown and reaping paths cover it. Cons: one more process per open
    OpenCode coordinator conversation; a cold start on its first turn.
  - **The project home environment's 2.x server.** Cons: shared with the
    user's own tabs in the same checkout, so the read-only launch would apply
    to them or not at all; project configuration cannot be off for one
    session.
  - **Session rules only, on any server.** Cons: the rules live in a database
    that a persisted record or a request could widen; no process authority.
  - Recommendation: the first.
- **Which credential the control tools use.**
  - **The 1.x launch's scoped credential (implemented).** Pros: no second
    issuance (issuing one revokes the conversation's other credentials);
    follows its rotation and revocation. Cons: the 2.x coordinator depends on
    its 1.x server being running, which the provider registry already
    ensures for every coordinator call.
  - **Issue a second credential at 2.x launch.** Cons:
    `issueCoordinatorCredential` revokes the conversation's other credentials,
    so each launch would break the other server's tools.
  - Recommendation: the first.
- **The tier.**
  - **Keep `provider-configured`, with the reason naming what 2.x adds and
    what is not qualified (implemented).** Pros: honest: the live coordinator
    suite has not run against 2.x with a real model, the table has one tier per
    platform while earlier conversations stay on 1.x, and the server process
    runs unsandboxed. Cons: undersells a 2.x coordinator, which holds every
    axis 1.x does not.
  - **A separate 2.x qualification at `enforced`.** Pros: closer to what the
    code holds (comparable to Pi's in-process gate). Cons: requires the live
    suite on 2.x and a per-line tier the picker cannot show today; claiming it
    without the live run breaks coordinator.md's rule.
  - Recommendation: the first, until `mise run test:agent:coordinator
    --credential-source opencode` passes with the preview on and the table can
    tell lines apart.
- **Provider commands on a 2.x coordinator.**
  - **Refused, catalogue `unsupported` (implemented).** Pros: 2.x's command
    list does not say which agent a command runs as, so the `plan` pin could
    not be checked; the session rules would still hold. Cons: `/review` and
    friends are unavailable to an OpenCode 2 coordinator.
  - **Allowed, relying on the session rules.** Cons: a command may switch the
    agent for its run; the pin would be advisory.
  - Recommendation: the first.
- **Sub-agents.** Left allowed, as on 1.x: a child session takes its
  parent's rules (verified on 2.2.6) and runs behind the same guard.

Evidence: unit tests (`coordinator.test.ts`, `coordinator-plugin.test.ts`,
`routing-provider.test.ts`, `opencode2-host-server.test.ts`,
`native-agent-opencode-protocol.test.ts`, `native-agent-runtime-liveness.test.ts`,
`native-agent-provider-registry.test.ts`) and
`opencode2-coordinator.live.test.ts` against the real 2.2.6 binary with a
scripted model: no write and no command; the data directory refused directly,
through a link, by `grep` and from a sub-agent; the control tool reached with
the conversation's credential and the research server's tool reached; a
session whose stored rules were widened to allow everything (and switched to
`build`) is refused a command by the server's guard and restated by the next
turn; a wider policy refused; a plugin and a local MCP server in the
checkout's configuration not loaded, where the same configuration loads under
a server without the switch.

Real stack, 2026-11-09, throwaway profile `oc2-w3-coord` (`dev:test --fixture
--agent-platforms opencode --no-agent-credentials`, since stopped and reset):
with the setting on, a new main coordinator conversation assigned to OpenCode
recorded `openCodeProtocol: "v2"` and started its own 2.x server
(`host-server.ready coordinator=true`); one turn on OpenCode's free
`opencode/big-pickle` asked to read `README.md`, write a file, run `touch`,
read the profile's `config.json` and call `list_environments`. It read the
README, had no write or shell tool, got the guard's data-directory refusal,
listed environments through Control MCP, and the checkout was unchanged.
Before the pruning fix the same flow failed at session creation with
`OpenCode provider was disposed`.

Not done: the live coordinator suite against 2.x with a real credential
(`test:agent:coordinator`), delegation round trips and research tools against
a real remote server on 2.x, a backend restart mid-conversation on the real
stack (covered only by the unit test that restates rules on resume and every
turn), and the user's own `OPENCODE_CONFIG_DIR` (ignored by the 2.x launch,
which always sets its own).

Integrated with "Task 5: phase 5 the user's global configuration": a
coordinator's own configuration directory also mirrors the user's global
OpenCode configuration (without plugins), so a 2.x coordinator sees the same
providers, models and `AGENTS.md` as a 1.x one. The guard plugin still
refuses every tool outside the read-only set, so the user's MCP servers load
but their tools are refused, as the session rules already did.

### Task 5: terminal tabs on 2.x (2026-11-10)

Reported: with terminal mode and the OpenCode 2 setting on, a new local
environment's OpenCode tab printed OpenCode 2's usage and `ERROR` instead of
starting. The tab ran `OPENCODE_DISABLE_AUTOUPDATE=1 opencode --model … --prompt
…`, a bare `opencode` that the login shell (`zsh -l`) resolved. macOS's
`path_helper` moves the managed toolchain directory that
`envWithManagedBinaries` prepends behind Homebrew, mise shims and
`~/.local/bin`, so the user's own `opencode`, a 2.x install, ran instead of
the pinned 1.19.5. The 2.x TUI has no `--model` (only `opencode run` does), so
it refused the line. The setting was not involved: terminal tabs ignored it.

Chosen (owner, 2026-11-10): terminal tabs follow the setting. A new tab is
rewritten when `bootstrap_terminal_session` delivers it
(`apps/backend/src/core/opencode2/terminal-launch.ts`):

- Only the exact line `buildTerminalAgentLaunchCommand` builds for OpenCode is
  rewritten (`parseTerminalOpenCodeLaunchCommand`), only in a local
  environment, and only while the setting is `v2`. Anything else, and an
  unreadable environment or setting, keeps the 1.x line and its private
  `OPENCODE_DB` exactly as before. A tab restored later is never
  re-bootstrapped, so existing tabs stay on the line they started on.
- The managed `opencode2` runs by its full path with `--standalone`, so it
  starts no background service that outlives the tab. It uses the host 2.x
  servers' database and configuration directory (`openCode2HostPaths`,
  `writeOpenCode2HostConfig`), the same flags, autoupdate off, the server
  credentials a shell may export unset, and a user `OPENCODE_CONFIG` only as
  its mirror. Sign-ins Orkestrator mirrors into the 2.x database therefore
  reach the tab, and the user's `opencode.db` is never opened.
- The model overrides only `model` in the terminal shell's existing
  `OPENCODE_CONFIG_CONTENT`. A managed Bun helper parses JSONC at launch time,
  outside the worktree and without dotenv loading; invalid or non-object input
  refuses the launch with a fixed error. The override is confined to a subshell.
  The earlier model-selection probe against 2.2.6 in an isolated `HOME`/XDG
  started the TUI on
  `opencode/glm-5.3-flash-free` when that was named, and on Big Pickle when it
  was not. The reasoning level is dropped, as for 1.x.
- With the setting on and no managed `opencode2`, the tab prints the same
  "not installed yet" message the native path raises rather than running 1.x.

Not changed: container terminal tabs stay on the image's 1.x `opencode`, even
on an image that carries `opencode2` (not checked: whether anything in a
container can put a 2.x `opencode` ahead of the image's). A 1.x tab on a host whose own
`opencode` is 2.x, with the setting off, still runs the user's binary. Not
run: a live terminal tab in a `dev:test` profile.

### Task 5: terminal bootstrap review fixes (2026-11-10)

**Choice: bootstrap ownership.** Pending ownership in the backend runtime
(recommended) adds a transient claim but preserves delivery semantics. The runtime owns one pending
preparation per PTY, duplicates await that operation, and snapshots report
`bootstrapped` only after a successful write. Cleanup and shutdown invalidate
pending ownership; continuations compare their claim, PTY and session config
before writing. This replaces publishing success before preparation: the old
form was smaller but could acknowledge failed launches and write to replaced
PTYs. Tests cover concurrent same/different data, preparation/write failure,
retry, replacement, close, shutdown and a second registry rehydrating state.

**Choice: inline configuration.** A shell-time merge (recommended) overrides only `model` in the effective shell
JSONC at execution time. A backend-only merge would be simpler but miss settings
exported by login scripts; replacing the document drops providers and permissions.
The Bun helper adds a short process for explicit-model launches, but preserves
those settings and refuses malformed input without echoing it. Shell tests cover
model/default selection, quoting, parent-environment isolation, invalid input and
project preload avoidance.

**Choice: canonical recognition.** A builder round trip (recommended) requires the parsed line to round-trip through
the existing builder, including its line ending. Expanding the regex exclusions
would be smaller but leave another escaping convention to maintain. Tests reject
raw variable/command expansion, empty arguments and extra trailing newlines,
while retaining escaped prompts and CRLF lines.

### Task 2: the start is settled by the preview (2026-11-10 housekeeping)

Checked against `main` at `04639b12b`. The task list still read "open ...
proposed but not yet confirmed" although the 2.x provider had been built and
merged as an opt-in preview (#2009, `2e7a39755`), and the folder index still
called this file a deferred checkpoint where nothing starts until the gate
opens. Chosen: mark task 2 done for the start and point the remaining
decision (whether the mitigations are accepted for a default switch) at task
7, and rewrite the index row from the task list and the merged code
(`apps/backend/src/core/opencode2/`). The row is re-rated Medium, a
provider-parity and qualification gap behind an opt-in switch, and keeps its
rank, which already sits after the last Medium row above it. The
alternative, leaving task 2 open, would keep saying that 2.x work has not
started.

### Tasks 3 and 4: reconcile preview completion (2026-11-10)

Reconciled against the implementation record already in task 5: phase 3
built the persisted protocol marker and per-session routing; phases 4 and 5
record the interactions, transcript, read-only permissions, structured output
and session features. Tasks 3 and 4 are done for the opt-in preview. Their
older decision-only notes above describe the 2.2.2 checkpoint, before that
implementation, rather than outstanding code work.

Chose to update the task summary statuses to match those dated records and
the index. Keeping the statuses open would retain historical wording but
misstate the preview's implementation. This closes no live qualification:
the remaining task 5 follow-ups, task 7 qualification and default decision,
and task 8 Session V2 work stay open.

### Stale checkpoint wording outside the task list (2026-11-10 housekeeping)

The paragraph that closes the Task analysis still said "do not bump ... to
2.x", gave 2.2.2 as the last upstream check and called `1.19.5` unpinned, and
Current state said nothing launches `opencode2`. All four predate #2009 and
the 2.2.6 recheck, and contradicted the task list and the index row. Chosen:
rewrite those sentences to the merged state (opt-in preview, 1.x default,
`1.19.5` pinned, 2.2.6 recheck) and leave the dated notes below them as
history. Leaving them would keep the file saying two things at once.

### Task 5: archive from the resume picker (2026-11-10)

Built against `main` at `c98b20e6f`. The 2.x provider already archived and
restored `opencode2:` ids (`PATCH /api/session/:id` with `archived`) and
listed archived rows on request, but OpenCode's platform table had no
`archive` action, so the backend refused the command and the picker offered
no remove and no "Show archived". Now:

- OpenCode's platform table reports `actions.archive`
  (`packages/protocol/src/native-agent.ts`), so the picker asks for archived
  rows and the backend admits the archive command.
- The resume entry has a new optional `archivable` field
  (`NativeAgentResumeEntry`, `ResumeEntrySchema`, contract manifest
  regenerated). The 1.x provider marks each of its rows `archivable: false`
  (`listOpenCodeResumableSessions`), and the picker
  (`NativeResumeSessionDialog`) shows no remove/restore control on such a
  row; the router still refuses a 1.x id.
- The 2.x provider refuses to archive a conversation it still holds for a
  tab or a run ("This conversation is open in a tab"), as the Codex and
  Cursor bridges answer 409; restoring is always allowed. Closing the tab
  releases it.
- `docs/architecture/agent-engines.md` ("Removing a conversation from the
  resume list") describes OpenCode's behaviour.

Tests: the dialog (a mixed list offers remove only on the archivable row),
the native tab (an OpenCode picker archives the 2.x row with
`includeArchived` asked), the session operations (OpenCode passes
`includeArchived` and keeps the marker; archive reaches the provider), the
router against the fake 2.x server (held conversation refused, archive after
close, the archived row listed only on request and not resumable, restore,
1.x id refused, 1.x never asked for archived rows), the 2.x features test,
the 1.x provider's rows, and the platform table.

Decisions:

- **How the picker learns that a 1.x row cannot be archived.**
  - **A per-row `archivable: false` from the provider, with the platform
    table offering `archive` (implemented).** Pros: one generic field any
    mixed list can use; the platform table keeps meaning "this platform may
    offer it", as it already does for `steer`; works when the 2.x router is
    absent, because the 1.x provider sets it. Cons: a new optional field in
    the contract; a renderer talking to an older backend shows remove on 1.x
    rows, and the backend's refusal is shown as a toast.
  - **Recognise 2.x rows in the renderer by their `opencode2:` prefix.**
    Pros: no contract change. Cons: puts a provider's id format into the
    shared picker.
  - Recommendation: the per-row field.
- **Refuse archiving a conversation a tab holds.**
  - **Refuse in the 2.x provider while it holds the session (implemented).**
    Pros: same behaviour as Codex and Cursor; a tab never keeps sending to a
    conversation the picker reports archived. Cons: a fork the provider
    registered but no tab opened is refused until the backend releases it.
  - **Archive regardless.** Pros: simpler. Cons: the holding tab would keep
    working on an archived conversation while another tab's list hides it.
  - Recommendation: refuse.

Not done: no live run of the picker against a real 2.x server; the fake
server (`fake-server.test-support.ts`) models the archive the 2.2.6 records
above describe. It belongs with task 7's qualification.

## Related

- [0005-mid-turn-steer-and-interrupt.md](0005-mid-turn-steer-and-interrupt.md) (OpenCode
  steer, built here for 2.x sessions).
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
