# OpenCode 2.x migration

Checked against `main` at `2459b05c` (2026-10-15).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Upstream recheck**: rerun the recheck procedure against the current 1.x and 2.x releases (the "Needs verification" item). Status: open (npm tags read on 2026-10-27; the spec, migration and OpenAPI reading is still to do).
2. **Readiness gate and start decision**: decide when the 2.x work may start, using the gate's open conditions. Status: blocked (upstream storage compatibility policy, stale-turn guard for steering, bounded inbox, MCP endpoints still experimental).
3. **Legacy 1.x session policy**: keep, migrate or retire existing 1.x sessions when 2.x arrives (open question 1, code item 5). Status: open.
4. **Losses to decide**: rebuild, capability-gate or drop each of the eight listed losses (code item 3, open question 2). Status: partly done (share already dropped with 1.19.1).
5. **`opencode2` provider**: a second provider with its own binary pin, `OPENCODE_DB`, `@opencode/client`, persisted protocol marker, snapshot-plus-hints projection and native steer/queue (code items 1, 2 and 4). Status: deferred.
6. **Changes that must ship with the first 2.x pin**: health probe on `/api/info` rejecting HTML, isolated `OPENCODE_DB` on host and container, GitHub-token plugin ported to `@opencode/plugin`, provider sign-in moved to `/api/credential`, live tests off `serve --pure`. Status: partly done (the compatibility probe no longer uses `--pure`).
7. **Qualification of the first 2.x pin**: the live probe, background, replay and capability checks listed under "Qualification". Status: deferred.
8. **Session V2 features after the move**: steer/queue, `switchAgent`/`switchModel`, context, log replay, staged revert, saved rules, credential/integration sign-in, `reference.list`. Status: deferred.

### 1. Upstream recheck

**Problem.** The upstream evidence (API mapping, readiness table) was last refreshed against 2.0.18 on 2026-09-27. Picking the work up on stale evidence risks building against routes that have since moved.

**Context.** The file's "Recheck procedure" (steps 1 to 5) and "Needs verification" describe the run. It must use an isolated `HOME`/`XDG_*`: 2.x migrates `opencode.db` in place on start (see "Coexistence and data").

**Investigation.** `npm view` on 2026-10-27: `@opencode/cli` latest is `2.1.4` (published 2026-10-23; 2.1.1 to 2.1.4 between 2026-10-20 and 2026-10-23), so 2.x has moved a minor line since the 2.0.18 checkpoint. `@opencode-ai/sdk` latest is still `1.19.4` (2026-10-22), matching every pin: `apps/backend/package.json:23`, `packages/toolchain/src/manifest.ts:10`, and `OPENCODE_CLI_VERSION` in `docker/Dockerfile` (comment at `docker/Dockerfile:189`, download at `:219`). The SDK patch is `patches/@opencode-ai%2Fsdk@1.19.4.patch`. 1.x is still shipping, so the "stay on 1.x" constraint holds. `mise run verify:opencode:live` exists (`mise.toml:327`). Not yet checked: whether 2.1 published a storage compatibility policy, a steer precondition, or moved MCP out of `/api/experimental`.

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

**Problem.** Existing OpenCode sessions live in the 1.x schema (`message`/`part`). 2.x migrates them into `session_v2`/`session_message` on start and drops the `event` table, and running 1.x against a migrated database is untested upstream.

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
    - Cons: 2.x removed the todo tool, so there is nothing to rebuild from.
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
  - **Only when 2.x lands, and only for 2.x (recommended).**
    - Pros: users keep sharing their 1.x history with their own TUI.
    - Cons: two database paths to document.
  - **Isolate it for 1.x now too.**
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

This is the deferred checkpoint for moving from the OpenCode 1.x line to
OpenCode 2.x. The decision is still: do not bump the OpenCode binary or SDK to
2.x. A 2.x server has no legacy HTTP API, so the move is a rewrite of the
backend OpenCode provider rather than a version bump. Upstream evidence was
last refreshed on 2026-09-27 against OpenCode `v2.0.18`. The 1.x line was
rechecked at `1.19.0` on 2026-10-11/13 (#964) and moved to `1.19.4` on
2026-10-23.

Three different things are called "v2" around OpenCode. The file name is kept
for existing links, but the text says "2.x" and never a bare "v2":

- **OpenCode 2.x** is the product line this file is about. It lives on upstream
  branch `v2`, ships under the new `@opencode/*` npm scope, and its server
  serves only `/api/*`.
- **`@opencode-ai/sdk/v2/client`** is the import path that `AGENTS.md`
  ("OpenCode SDK v2 - CRITICAL") requires. It is the current generated client
  of the 1.x SDK, and it drives the 1.x server. Sixteen backend files import it.
  That rule is correct and unaffected by anything here; "SDK v2" there does not
  mean OpenCode 2.x.
- **Session V2** is the experimental session protocol inside 1.x
  (`client.v2.*`, `session.next.*` events). It is what shipped as OpenCode 2.0.
  The repository has zero `client.v2.*` call sites.

## Current state

- Pin: `1.19.4` for `@opencode-ai/sdk` (`apps/backend/package.json`) and the
  CLI (`PINNED_TOOLCHAIN_VERSIONS.opencode` in
  `packages/toolchain/src/manifest.ts`, `OPENCODE_CLI_VERSION` in
  `docker/Dockerfile`). `tests/unit/version-drift.test.ts` keeps them in step.
  The SDK carries a patch (`patches/@opencode-ai%2Fsdk@1.19.4.patch`, the
  generated SSE client's unhandled `reader.cancel()` rejection).
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
  defaults to `GET /global/health` and treats any 2xx as healthy. See the hazard
  below.
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

Hazard: because `checkHttpHealth` accepts any 2xx on `/global/health`, a
binary-only bump would report the server healthy and then fail every session
call. Any pin change must move the probe to `GET /api/info` and reject HTML.

The only way to run both is two binaries: 1.x for legacy sessions and 2.x for
new ones, each with its own data directory or `OPENCODE_DB`.

### API mapping (`/openapi.json`, 2.0.18)

| 1.x (what the provider calls) | 2.x |
| --- | --- |
| `GET /global/health` | `GET /api/info` (`{version,pid,urls,paths}`) |
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
| `session.todo`, `todo.updated` | none: the todo tool was removed (`7feefb697f`) |
| `lsp.status`, `formatter.status` | none: 2.x does not run LSP |
| none | new: `inbox` (queued input), `background`, `switchAgent`/`switchModel`, `move`, `context`, `environment`, `shell`, `synthetic`, `worktree`, `vcs`, `credential`, `integration` |

The 2.x client package is `@opencode/client` (`OpenCode.make({ baseUrl,
headers, fetch })`), not `createOpencodeClient`. `@opencode/sdk` is now an
in-process embedded host (`OpenCode.create()`), not an HTTP client.

### Upstream readiness at 2.0.18, against the August 2026 gaps

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
  releases.
- ~~Share implemented, or Orkestrator accepts dropping it.~~ Dropped with 1.19.1.
- 2.x equivalents for per-prompt model, agent and tools and for structured
  output, or accepted replacements.
- Runtime-context gaps (LSP, `CLAUDE.md` fallback, compaction tuning) closed or
  accepted.
- Active-run ownership that supports a stale-turn guard for steering.
- A bounded inbox, or one the client can bound.
- MCP add and remove endpoints out of `/api/experimental`.

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

2. Read, pinned to the release tag: `specs/v2/session.md`,
   `services/www/src/docs/content/migrate-v1.mdx`, `V2_HTTP_API_AUDIT.md`,
   `packages/schema/src/prompt-input.ts`, and the database migrations since the
   last checkpoint.
3. Install the 2.x CLI into a temporary directory and run it with an isolated
   `HOME` / `XDG_*`, never against the real data directory. Diff `/openapi.json`
   against the routes the provider calls.
4. Run `mise run verify:opencode:live` for the 1.x pin.
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
    progress at `GET /api/experimental/migration/v1`. The 2.x schema has no
    `message`/`part` tables. The host database on the development machine was
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
    `OPENCODE_SERVER_PASSWORD` still works; `OPENCODE_SERVER_USERNAME` is
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

- Upstream state since 2026-09-27 (2.0.18): a newer 2.x release, a storage
  compatibility policy, a steer precondition, MCP endpoints leaving
  experimental. Run the recheck procedure above before picking this up.

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
