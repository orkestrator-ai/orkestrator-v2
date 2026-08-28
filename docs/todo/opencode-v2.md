# OpenCode V2 session protocol migration checkpoint

Status: deferred; do not migrate production OpenCode sessions yet.  
Recorded: 2026-08-28  
Code reviewed: `3962f549`  
Orkestrator OpenCode SDK and CLI pin: `1.18.23`  
Latest SDK version observed in the package registry: `1.18.25`

## Purpose

Orkestrator imports the V2 entry point of the OpenCode JavaScript SDK, but it
still drives sessions through OpenCode's legacy, unprefixed HTTP API. OpenCode
also exposes a newer Session protocol under `/api/session` with durable prompt
admission, event-sourced history, idempotent client message IDs, and native
`steer`/`queue` delivery modes.

Those features are attractive, especially for native `/steer`, but the V2
Session implementation is not currently a stable replacement for the legacy
runtime. This document records the distinction, the probe evidence, the
upstream gaps, and the conditions that should be true before the migration is
picked up again.

This is a checkpoint, not an implementation plan. Revalidate every upstream
claim against the exact SDK and CLI version selected for a future upgrade.

## Terminology: two different meanings of “V2”

The package name and the Session protocol are separate version axes.

| Term | Meaning |
| --- | --- |
| V2 SDK client | `@opencode-ai/sdk/v2/client`; flat TypeScript parameters and the current generated client |
| Legacy/V1 Session API | `client.session.*`; unprefixed routes such as `/session/:id/message` and `/session/:id/prompt_async` |
| V2 Session API | `client.v2.session.*`; routes under `/api/session`, including durable `prompt(...)` admission |

OpenCode's own migration checklist uses the same definition: V1 means the
legacy unprefixed APIs even when they are reached through the package's V2 SDK
entry point.

Therefore this repository is currently:

> **V2 SDK client, legacy/V1 Session protocol.**

It is incorrect to infer that an import from `@opencode-ai/sdk/v2/client` means
that session execution is already using `/api/session`.

## Current Orkestrator implementation

The main backend integration is
[`opencode-provider.ts`](../../apps/backend/src/core/opencode-provider.ts). It
imports `createOpencodeClient` from the V2 SDK entry point, then uses
`client.session`, not `client.v2.session`.

The current turn path depends on the legacy projection:

1. `client.session.create(...)` creates the session.
2. `client.session.messages(...)` reads the canonical legacy transcript before
   dispatch and during reconciliation.
3. `client.session.promptAsync(...)` dispatches an ordinary prompt.
4. A caller-owned `messageID` is embedded in the legacy user message so an
   ambiguous dispatch can be reconciled from that transcript.
5. Legacy session/message events update the renderer and backend projections.

The provider also uses legacy operations that do not yet have direct, complete
V2 Session parity:

- `command` for discovered slash commands;
- `fork`;
- `summarize` for manual compact;
- `revert` and `unrevert` for undo/redo;
- `share` and `unshare`;
- `abort`;
- `delete` during tab teardown.

The exact SDK/CLI match is deliberate. The pins live in:

- [`apps/backend/package.json`](../../apps/backend/package.json);
- [`apps/web/package.json`](../../apps/web/package.json);
- [`toolchain-manifest.ts`](../../apps/desktop/electron/toolchain-manifest.ts);
- [`docker/Dockerfile`](../../docker/Dockerfile).

[`opencode-live-compatibility-probe.ts`](../../scripts/opencode-live-compatibility-probe.ts)
checks that the installed SDK and running CLI match and that a basic legacy
session list works. It does not currently qualify the V2 Session runtime.

## What V2 offers

The V2 Session API has several stronger primitives than the legacy prompt path:

- durable prompt admission before model-visible promotion;
- a caller-supplied message ID with exact-retry idempotency;
- conflict rejection when the same ID is reused with different input;
- explicit `delivery: "steer" | "queue"`;
- `resume: false` to admit work without waking a runner;
- ordered projected messages based on durable aggregate sequence;
- finite durable event history and replay/tail event streams;
- explicit agent and model switching;
- a process-local active-session snapshot and interrupt operation.

These are the right architectural ingredients for queueing, reconnect-safe
rendering, and same-run steering. They are not, by themselves, evidence that
the surrounding runner has reached legacy behavioral parity.

## Live compatibility probe results

The following was measured on 2026-08-28 against OpenCode CLI and SDK
`1.18.23`, using a temporary server and real authenticated model turns.

### Shared identity, separate execution and projection

- A session created through the legacy API was readable by V2 using the same
  session ID. The two APIs therefore address a shared top-level session
  identity.
- V2 prompt admission into that session did **not** join a legacy
  `promptAsync` run. It started a separate V2 execution while the legacy turn
  continued concurrently.
- The V2 input and output appeared in V2 history but not in the legacy
  `client.session.messages(...)` projection.
- The legacy turn completed its original instruction unchanged; the V2 runner
  separately handled the steering text.

This disproves the safe-looking hybrid migration where only `/steer` calls the
V2 endpoint while ordinary turns, transcript reads, and events remain legacy.
Shared session IDs do not imply a shared runner or read model.

### Pure V2 behavior

Within a session driven entirely through V2:

- a prompt admitted with `delivery: "steer"` joined the same serialized V2
  drain;
- a second steer admitted during generation waited until the next safe model
  iteration rather than interrupting the current token stream;
- the runner made the steered instruction model-visible before it settled;
- exact reuse of a prompt ID returned the original admission receipt;
- reuse of that ID for different input returned a conflict;
- the legacy message projection remained empty for the pure V2 conversation.

This establishes that the native primitive is real. It also confirms that a
V2 session must use V2 history and events as its authoritative read path.

### Stale steer behavior

V2 prompt admission has no `expectedTurnId` or equivalent active-run
precondition.

- A `delivery: "steer", resume: true` request sent after the observed turn had
  become idle started new work.
- `resume: false` can prevent the immediate wake, but leaves the stale input
  durably admitted for a later wake.
- The generated SDK exposes no atomic “admit only if this run is still active”
  or “withdraw this admitted input” operation.

Consequently, migrating to V2 would provide native steering and caller-ID
idempotency, but would not by itself provide Codex-like stale-turn rejection.
Do not advertise a full turn-pinned `/steer` contract until this is solved by
OpenCode or by a mechanism that is atomic with V2 admission.

## Upstream status as of 2026-08-28

OpenCode's upstream documents still describe V2 Session events, projections,
and databases as experimental/pre-launch state. Its compatibility strategy has
included resetting V2 event, input, projection, context-epoch, workspace, and
sequence tables while preserving canonical legacy `session`, `message`, and
`part` rows.

That means V2 currently has a weaker persistence promise than the legacy data
Orkestrator relies on for resume and dispatch reconciliation.

OpenCode's own application is also still hybrid. Its V1 migration checklist
retains unprefixed calls and compatibility adapters while the `/api` surfaces,
events, and UI projections are migrated. Notable open items include session
status, mutation, deletion, abort, revert, compact, commands, shell, fork,
sharing, permissions, questions, events, and legacy type adapters.

### V1 runtime-context parity is incomplete

The upstream V2 Session specification marks the following model-visible
behaviors partial or missing:

- configured local, glob, and remote instructions;
- nested instructions discovered after file reads;
- full agent system prompts and effective request policy;
- provider/model-specific base instructions;
- complete policy-filtered built-in, MCP, plugin, and structured-output tools;
- per-prompt system text and tool overrides;
- plan/build switching and final-step reminders;
- plugin message, system, parameter, and header transforms;
- full model variant/request settings;
- structured-output policy;
- native template and `@` mention expansion;
- complete file, directory, media, MCP-resource, agent, and configured-reference
  expansion.

The V2 runner also deliberately defers provider timeout/watchdog policy and
post-crash continuation recovery. A wake does not infer that an ambiguous
provider dispatch is safe to retry after input promotion.

### Advertised routes are not all implemented

The generated V2 client for the repository pin exposes the following Session
methods:

```text
list, create, active, get, switchAgent, switchModel, prompt, compact,
wait, context, history, events, interrupt, message, messages
```

At least `compact` and `wait` currently reach core implementations that return
`OperationUnavailable`; their HTTP routes exist ahead of working behavior.

The legacy Session client additionally exposes operations including:

```text
status, delete, update, children, todo, diff, promptAsync, command, shell,
fork, abort, init, share, unshare, summarize, revert, unrevert
```

Some of these have emerging V2 replacements elsewhere in the API rather than
on `client.v2.session`. Others are absent or intentionally redesigned. The
upstream migration checklist explicitly says:

- the current API has no sharing contract or implementation;
- historical session diffs remain unavailable pending snapshot semantics;
- commands, shell, fork, revert, compact, abort, and deletion still have
  migration work;
- current production code retains legacy session/message fallbacks.

Do not treat the presence of a generated method as proof that the handler is
implemented, durable, or behaviorally equivalent.

### Remaining reliability work in V2

The upstream specification also records these operational gaps:

- post-crash provider-dispatch ambiguity is not modeled yet;
- distributed active-run acquisition, stale-runtime rejection, interruption,
  and placement orchestration remain future work;
- explicit inbox backlog and steering-batch limits are needed before broad
  multi-caller exposure;
- eager local tool execution is currently unbounded;
- replay is durable for lifecycle events, but live text, reasoning, and
  tool-input fragments are intentionally ephemeral and require a separate
  renderer handoff design.

These matter directly to Orkestrator's background-reliability, bounded-memory,
and at-most-once dispatch invariants.

## Why a production migration is deferred

Even if implementation cost is ignored, a wholesale migration today would
accept product and durability regressions:

1. **Experimental durable state.** V2 storage and event compatibility are not
   yet promised across releases.
2. **Different model behavior.** Important instructions, policies, plugins,
   prompt expansion, and structured-output behavior are incomplete.
3. **Missing session actions.** Current OpenCode features would disappear or
   require behaviorally different replacements.
4. **Incomplete recovery.** The V2 runner does not yet settle post-crash
   dispatch ambiguity to Orkestrator's standard.
5. **No atomic stale-turn guard.** Native steer can race into a later idle
   drain.
6. **Unsafe hybrid mode.** Live probing proved that V1 and V2 execution can run
   concurrently against one session ID and project different histories.

Updating only the package from `1.18.23` to a later `1.18.x` does not perform
this migration. The change is selecting `client.v2.session` and replacing the
entire authoritative lifecycle around it.

## Required migration shape when V2 is ready

A future implementation should preserve one protocol mode for the full life of
each Orkestrator/OpenCode session.

### Do not mix turn protocols

- Create new V2 sessions through the V2 API.
- Dispatch every prompt, queue item, and steer through V2 admission.
- Read transcript snapshots and replay events through V2 projection/history.
- Rehydrate status, pending permissions/questions, and queued input from V2
  authoritative state.
- Never send a V2 prompt into a turn dispatched by legacy `promptAsync`.
- Never use the legacy message list to decide whether a V2 input ran.

If legacy and V2 sessions must coexist during rollout, persist the selected
protocol mode with the session mapping. Do not infer it from the server version
or from whether one endpoint happens to return the session ID.

### Treat events as incremental updates over snapshots

The V2 implementation must follow the repository's normal inactive-environment
rules:

- obtain an authoritative snapshot/history page on mount or activation;
- subscribe before calculating and flushing replay;
- detect cursor expiration, sequence gaps, or generation changes;
- keep ephemeral deltas separate from durable cursor advancement;
- recover after bridge/backend/UI restarts without relying on missed live
  events;
- bound history pages, replay buffers, decoded events, deltas, and pending
  inputs by bytes and count.

### Preserve at-most-once dispatch semantics

- Use the Orkestrator request ID as the V2 prompt/message admission ID.
- Treat an exact admission retry as reconciliation, not as another prompt.
- Preserve conflict and ambiguous outcomes rather than silently changing IDs.
- Define recovery after admission but before promotion, after promotion but
  before provider acknowledgement, and after process death.
- Do not claim Codex-like `/steer` until stale-run admission is atomically
  rejected or can be safely withdrawn.

### Replace every required legacy feature deliberately

For each existing use of `client.session`, choose one of:

1. a V2 operation with verified equivalent behavior;
2. a provider-independent Orkestrator implementation that does not touch the
   legacy turn projection; or
3. an explicitly removed capability with honest UI gating and migration notes.

Do not route an action through V1 merely because V2 has not implemented it if
that action can mutate session execution or transcript state.

## Readiness gate

Reconsider making V2 the production default only after all required items are
checked against the exact proposed SDK/CLI pin.

### Upstream contract

- [ ] V2 Session events and projections are declared shipped/stable rather than
  disposable experimental state.
- [ ] Upstream documents a compatibility and migration policy for existing V2
  sessions across upgrades.
- [ ] OpenCode's own app no longer depends on legacy Session fallbacks for the
  behaviors Orkestrator needs.
- [ ] `compact` and `wait` are implemented, or Orkestrator has accepted,
  provider-independent replacements.
- [ ] Required command, shell, fork, share, revert, delete, abort/interrupt,
  diff, permission, and question semantics are implemented and documented.
- [ ] The V1 runtime-context parity checklist is complete for the features and
  providers Orkestrator exposes.
- [ ] Post-crash continuation and provider-dispatch ambiguity have documented,
  testable outcomes.
- [ ] Active-run ownership and stale-runtime rejection are sufficient for the
  desired steering contract.
- [ ] Queue, steering, event, delta, and tool-execution bounds are documented or
  enforceable by the client.

### Orkestrator qualification

- [ ] SDK, CLI, container, and desktop toolchain versions are pinned to one
  exact release.
- [ ] A live V2 compatibility probe covers create, prompt, exact retry,
  conflict, history, replay/tail handoff, interrupt, permissions/questions,
  restart, and teardown.
- [ ] Every current `client.session` use has a reviewed V2 disposition.
- [ ] The session mapping persists `legacy` versus `v2` while both can exist.
- [ ] Existing legacy sessions have an explicit keep, migrate, export, or
  retire policy; they are never silently opened under V2 execution.
- [ ] Background tests run a turn, switch environments, allow it to progress,
  and verify correct rehydration on return.
- [ ] Restart tests cover admission-before-promotion and
  promotion-before-provider-acknowledgement.
- [ ] Replay tests cover subscribe-before-replay, sequence gaps, cursor expiry,
  ephemeral deltas, and bounded memory.
- [ ] Session actions and UI capability flags match the behavior actually
  available on V2.
- [ ] Native `/steer` is tested for idle and end-of-turn races, not only the
  successful same-drain case.

## Recheck procedure

When revisiting this document:

1. Read the upstream V2 Session specification, schema changelog, and V1 API
   migration checklist from the same OpenCode commit or release.
2. Inspect the generated `client.v2.session` methods in the proposed SDK pin and
   trace each required route to its core handler. Search for
   `OperationUnavailable`, placeholder handlers, and compatibility adapters.
3. Compare registry and repository pins:

   ```sh
   bun pm view @opencode-ai/sdk version
   rg -n '"@opencode-ai/sdk"|OPENCODE_CLI_VERSION|opencode:' \
     apps docker package.json --glob '!**/node_modules/**'
   ```

4. Run the existing version/legacy smoke probe:

   ```sh
   bun run verify:opencode:live
   ```

5. Add or run a V2-only live probe covering the qualification cases above. Do
   not qualify V2 by calling one V2 endpoint inside a legacy-created running
   turn.
6. Update the recorded date, pins, upstream status, probe evidence, and every
   readiness checkbox. Do not rely on this document's 2026-08-28 conclusions
   after changing the OpenCode pin.

## Primary upstream references

- [V2 Session specification](https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md)
- [V2 schema changelog](https://github.com/anomalyco/opencode/blob/dev/specs/v2/schema-changelog.md)
- [V1 API migration checklist](https://github.com/anomalyco/opencode/blob/dev/packages/app/V1_API_MIGRATION.md)
- [V2 Session core implementation](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session.ts)
- [V2 Session HTTP handlers](https://github.com/anomalyco/opencode/blob/dev/packages/server/src/handlers/session.ts)
- [V2 Session protocol routes](https://github.com/anomalyco/opencode/blob/dev/packages/protocol/src/groups/session.ts)

The upstream links target `dev` because that is where the current V2 status is
documented. For a future migration decision, replace them with links pinned to
the exact release commit being qualified.
