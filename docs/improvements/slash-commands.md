# Provider slash commands: investigation and recommendations

Status: investigation complete; implementation proposed, not started.
Investigated 2026-09-21 at commit
`88c2f9ccfaa68045573b658dd4f172bc5ff7c51b`.

Implementation sequence: [plan index](slash-commands/plan/00-index.md).

## Recommendation

Make the command catalogue describe what this integration can actually execute.
Each entry needs an invocation identity, an execution route, and availability
information, in addition to its display name and provenance. Resolve commands
authoritatively in the backend/bridge before shaping or dispatching a prompt.
Keep the existing shared composer, provider adapters, session actions, dispatch
journals, and projection infrastructure.

The largest gains are correctness fixes, not a bigger menu:

1. Remove invented support from hard-coded Claude and OpenCode lists.
2. Invoke Claude skills using their actual command names and Codex skills using
   structured app-server input. `/skill:name` is Pi syntax, not a shared API.
3. Preserve command identity through aliases, arguments, queues, and retries.
4. Make discovery failures and stale lists visible without blocking chat.
5. Add slash shortcuts to existing Orkestrator controls only when their exact
   behavior and capability are implemented, starting with steering and compact.

Do not promise parity with every provider's terminal/editor slash menu. Some
entries run prompts; others manipulate a terminal, open an editor, change
settings, replace a session, or invoke a separate runtime operation.

## Scope and evidence

This is a source investigation, supplemented by current primary documentation
and installed SDK declarations/source. No application code changed. No live
provider sessions, billable prompts, or integration tests were run. Defects
below are demonstrated at the code/contract level; actual provider responses
and version-specific edge cases still need the qualification in plan step 01.

Repository pins inspected:

| Integration | Pinned dependency/runtime |
| --- | --- |
| Claude | Agent SDK `0.3.276`; CLI `2.1.276` |
| Codex | CLI/app-server `0.155.0`; committed generated protocol |
| OpenCode | SDK and CLI `1.18.31`, SDK `/v2/client` import |
| Pi | SDK and CLI `0.85.1` |
| Grok | Build `1.0.34`; ACP SDK `1.4.0` |
| Cursor | SDK `1.0.31` |

Pins come from the bridge package manifests, backend manifest, and
[`docker/Dockerfile`](../../docker/Dockerfile). Online documentation can be
ahead of these versions. Installed types and the generated protocol constrain
implementation; a feature appearing in newer docs is not proof of support.

The earlier [SDK coverage plan 06](../plans/sdk-coverage/06-commands-skills-and-templates.md)
is useful history but not an accurate task checklist for this checkout.
Normalized fields, source grouping, session routes, Claude SDK discovery,
Codex skill listing, Pi extension/skill listing, and Grok command persistence
already exist. That plan explicitly excluded execution changes; this proposal
addresses the discovery/execution mismatch and should supersede its remaining
command work when implementation begins.

## What already works

The active native UI uses `AgentNativeTab.controller.tsx`, a shared
`useSlashCommandMenu`, and `SlashCommandMenu`. Commands arrive in a backend-owned
session projection. The protocol already has `name`, `description`,
`argumentHint`, `source`, `aliases`, and `scope`; the picker groups by source and
shows argument hints. This is an incremental extension of an existing feature.

The backend's `projectionSlashCommands` has a 30-second cache, a 256-key bound,
512-command result limit, in-flight deduplication, stale-while-refresh behavior,
and invalidation guards. Expired lists do not hold up transcript refresh.
Explicit model-catalogue refresh also invalidates command caches. OpenCode
clears its separate command-name cache on that refresh too.

`/steer` is already capability-gated and dispatched as a runtime action during a
running turn. Its idle fallback is handled locally by the providers. OpenCode
already routes recognized interactive commands through `session.command`,
including an empty `arguments` string for bare commands and separate file
parts. Grok already persists its advertised command inventory. Pi already runs
templates, skills, and extension commands through its SDK prompt path.

References:
[protocol](../../packages/protocol/src/agent-slash-commands.ts),
[projection](../../apps/backend/src/core/native-agent-service-projection.ts),
[cache constants](../../apps/backend/src/core/native-agent-service-shared.ts),
[refresh](../../apps/backend/src/core/native-agent-service-base.ts),
[composer](../../apps/web/src/components/native-agent/AgentNativeTab.controller.tsx).

## Discovery and execution by provider

| Provider | Current catalogue | Current execution | Assessment |
| --- | --- | --- | --- |
| Claude | SDK `supportedCommands`, cached inventory, fallback probe; init skills appended; backend also injects built-ins | Slash text sent to Agent SDK query | Good SDK integration undermined by invented rows, wrong appended skill syntax, and incomplete update handling |
| Codex | Project/user prompt files, three bridge built-ins, skills extracted from runtime health | Bridge handles `/help`, `/models`, `/steer`; expands prompt files; remaining text goes to app-server | Listed skills do not have a corresponding explicit invocation implementation |
| OpenCode | Two `command.list` calls plus a hard-coded TUI list | Any listed name can enter `session.command` on interactive send | Discovery combines two different command surfaces and loses canonical metadata |
| Pi | Templates, skills, extensions from attached SDK session; duplicate refresh implementation | `session.prompt`, template expansion enabled, source `rpc` | Closest to matched discovery/dispatch; collisions, headless extensions, refresh, and compact need attention |
| Grok | ACP `available_commands_update`, persisted per session | Command text in `session/prompt` | Correct architecture; input-hint parsing and freshness are incomplete |
| Cursor | Empty catalogue; provider capability disabled | Ordinary SDK prompts, plus supported Orkestrator actions | Keep provider commands unsupported until an SDK contract is demonstrated |

## Findings

### F01 — Hard-coded inventories claim unsupported behavior

**Priority: high.** `HttpBridgeCatalogAdapter` seeds every Claude result with 15
entries, including `/vim`, `/logout`, and `/permissions`, even when the SDK
returns a successful empty list. SDK discovery therefore cannot remove them.
The legacy Claude filesystem route has its own discovery implementation.

OpenCode's `listOpenCodeSlashCommands` always adds 17 entries, including
`/themes`, `/editor`, and `/exit`. `resolveProviderCommand` builds its executable
name set from this merged list. An editor command can consequently be sent to
the server's custom-command endpoint. The source proves the routing mismatch;
the exact error returned by the pinned server requires a live fixture.

Use authoritative discovery for provider commands. Offer selected equivalents
as explicitly implemented Orkestrator actions. Keep terminal/editor-only
commands out of the executable picker, with a useful explanation when a user
types a known unsupported name.

Evidence: [HTTP catalogue](../../apps/backend/src/core/http-bridge-catalog.ts),
[OpenCode catalogue](../../apps/backend/src/core/opencode-commands.ts),
[OpenCode dispatch](../../apps/backend/src/core/opencode-provider.ts),
[legacy Claude scanner](../../bridges/claude-bridge/src/services/slash-commands.ts).

### F02 — Claude skill syntax and provenance are synthesized incorrectly

**Priority: high.** `normalizeCommands` appends init skill `foo` as `/skill:foo`,
even when SDK discovery already returned `/foo`. The installed `SlashCommand`
type exposes name, description, argument hint, and aliases, but no source or
scope. `commandSource` casts extra metadata and falls back to `builtin`, so
absence of provenance becomes a positive, often false builtin label.

Use the SDK command name unchanged; annotate matching init names as skills
without adding a second invocation. Keep plugin namespaces intact. Report
unknown provenance honestly. A standalone cold `createProbe()` also lacks the
active query's full settings/plugin/policy configuration; qualify its results
against the real query before calling them session-authoritative.

Evidence: [Claude catalogue](../../bridges/claude-bridge/src/services/session-manager-catalog.ts),
[query/init handling](../../bridges/claude-bridge/src/services/session-manager-prompt.ts).
The official [Claude SDK command documentation](https://code.claude.com/docs/en/agent-sdk/skills#commands-in-agent-sdk-sessions)
describes `/<name>` dispatch and a session-specific noninteractive inventory.

### F03 — Codex advertises skills without transporting skill input

**Priority: high.** `/session/:id/commands` emits `/skill:<name>` rows, but
`resolveSlashCommand` only implements bridge built-ins and scanned templates.
`EngineUserInput` supports text and local images only, and `toAppServerInput`
has no skill branch. A selected skill therefore has no explicit provider skill
binding and can reach the model as ordinary slash-prefixed text.

The pinned generated protocol already supports `{type: "skill", name, path}`.
Skill metadata includes `path`, `enabled`, `pluginId`, and scope values
`user | repo | system | admin`. The current health projection intentionally
removes paths; using that sanitized diagnostics response as the catalogue
source loses information needed for invocation. The route also ignores
`enabled` and compares scope with `project`, which never matches `repo`.

Create a dedicated typed skill inventory owned by the bridge. Keep paths
private and resolve them from a session-scoped opaque command ID. Invoke with
explicit skill input and accompanying text, preserving the user's arguments.

Evidence: [route](../../bridges/codex-bridge/src/index.ts),
[resolver](../../bridges/codex-bridge/src/app-server-runtime-prompt.ts),
[engine types](../../bridges/codex-bridge/src/engine/types.ts),
[engine serializer and health sanitization](../../bridges/codex-bridge/src/engine/app-server-engine.ts),
[pinned UserInput](../../bridges/codex-bridge/src/app-server/generated/typescript/v2/UserInput.ts),
[pinned SkillMetadata](../../bridges/codex-bridge/src/app-server/generated/typescript/v2/SkillMetadata.ts).
Official [app-server documentation](https://learn.chatgpt.com/docs/app-server#skills)
shows explicit skill inputs, `$name` text, and skill-list invalidation.

### F04 — There is no shared executable command contract

**Priority: high.** A `NativeAgentSlashCommand` is a display record, not an
execution descriptor. There is no stable ID, native invocation, execution kind,
availability reason, attachment policy, or busy-state policy. The UI inserts a
string; each provider subsequently guesses what it means.

`source` cannot fill this role: a skill, a plugin prompt, and a builtin can each
require different transport. Keep provenance independent from execution.
Add an optional explicit command selection to the existing prompt transaction;
the backend must validate it against its own catalogue. Do not let a client
submit arbitrary RPC methods, filesystem paths, or shell templates.

Evidence: [protocol shapes](../../packages/protocol/src/native-agent.ts),
[provider contract](../../apps/backend/src/core/agent-provider-contract.ts),
[HTTP prompt transport](../../apps/backend/src/core/http-bridge-provider.ts).

### F05 — Parsing and name resolution disagree

**Priority: high.** The shared parser lowercases names and accepts multiline
arguments. The Codex template parser rejects any newline and splits only on a
literal space. Thus a command recognized by the composer can become plain text
at execution. OpenCode uses the lowercased parsed name as the outgoing name
instead of retaining a provider's canonical spelling; aliases are not in its
execution-name set. The picker searches names only, despite protocol aliases.

The shared runtime merge deduplicates by lowercase name. If steering capability
is absent, it deletes `/steer` even if that was the provider's own command.
When steering is present, it overwrites that spelling. These are implicit
collision policies, not reliable provider semantics.

Preserve raw text and canonical provider identity. Share lexical parsing, but
make matching rules and final syntax adapter-owned. Define collisions and
alias precedence explicitly; never silently substitute a different command.

Evidence: [shared parsing/merge](../../packages/protocol/src/agent-slash-commands.ts),
[Codex parsing](../../bridges/codex-bridge/src/prompts/slash-commands.ts),
[picker hook](../../apps/web/src/hooks/useSlashCommandMenu.ts),
[OpenCode resolver](../../apps/backend/src/core/opencode-provider.ts).

### F06 — Catalogue freshness has no user-visible state

**Priority: medium/high.** The projection carries an optional list, with no
distinction between loading, empty, failed, unsupported, or stale. Discovery
failures can become empty lists; OpenCode suppresses both list errors and
retains its hard-coded rows. Its dispatch resolver intentionally falls back to
plain prompt text on discovery failure. That is especially undesirable after
a user explicitly selected a command.

Retain stale data for display, but revalidate explicit execution. A selected
command that disappeared or cannot be verified should preserve the draft and
return a specific error. Ordinary unknown slash-prefixed text and absolute
paths should remain usable as messages through an explicit literal-text path.

Evidence: [projection/cache](../../apps/backend/src/core/native-agent-service-projection.ts),
[OpenCode discovery](../../apps/backend/src/core/opencode-commands.ts).

### F07 — Provider command changes do not consistently invalidate snapshots

**Priority: medium/high.** The installed Claude SDK defines
`system/commands_changed` as a full replacement list, but the bridge has no
explicit handler for it. A live `supportedCommands()` read may recover changes;
the post-turn cached inventory can remain old. Codex explicitly ignores
`skills/changed`. Grok updates its revision and persists the list, while the
backend has a separate TTL cache; that path needs a freshness contract rather
than an assumption that every UI sees every update.

Use generation/revision invalidation and authoritative re-reads. Do not add a
background loop that polls tab-facing routes or reattaches idle sessions.

Evidence: [Claude stream handling](../../bridges/claude-bridge/src/services/session-manager-prompt.ts),
[Codex ignored notifications](../../bridges/codex-bridge/src/app-server/event-reducer.ts),
[Grok update handling](../../bridges/acp-bridge/src/acp-session.ts).

### F08 — Codex template compatibility has correctness and execution hazards

**Priority: high for the existing shell path.** The scanner recursively reads
whole Markdown files without traversal, file-size, or aggregate-byte bounds.
It accepts `argument_hint`/`arguments`, but not the common `argument-hint`
spelling. Expansion substitutes `$ARGUMENTS`, then executes every resulting
`!`-backtick fragment through a shell outside app-server approval/sandboxing.
An argument can introduce a new executable fragment. Output has a per-process
bound, but there is no explicit execution deadline or aggregate expansion cap.

This is a repository-owned compatibility feature and must be labelled as such.
Do not silently extend it into a universal provider command engine. Recommend
disabling shell expansion by default, rejecting affected explicit commands
with an explanation, and only retaining an opt-in path once it shares a
reviewed execution-policy boundary. Parse original template structure before
substituting arguments; argument text must never create shell instructions.

Also fix `/help` and `/models` collisions: discovery allows templates to occupy
those names, but execution handles the built-ins before looking up templates.

Evidence: [Codex template discovery/expansion](../../bridges/codex-bridge/src/prompts/slash-commands.ts),
[builtin dispatch order](../../bridges/codex-bridge/src/app-server-runtime-prompt.ts).

### F09 — OpenCode provenance is inferred from request position

**Priority: medium.** The second `command.list({directory})` response is tagged
entirely as `project`; the first response is tagged `user`. A scoped response
can contain inherited or server-defined commands. Directory scope does not
prove ownership. Agent/model/subtask metadata is not represented in the shared
catalogue, although it affects what the provider does.

Use the effective directory-scoped catalogue and retain canonical execution
metadata privately. Expose provenance only where supplied or independently
verified. Let the provider resolve templates and subtask behavior; do not
reimplement them in the renderer.

Evidence: [OpenCode catalogue](../../apps/backend/src/core/opencode-commands.ts),
[dispatch](../../apps/backend/src/core/opencode-provider.ts).
Official [OpenCode command docs](https://opencode.ai/docs/commands/) distinguish
custom templates and their agent/model/subtask settings; the
[server API](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/server.mdx)
provides command execution separately from prompt submission.

### F10 — Pi discovery is duplicated and does not express execution precedence

**Priority: medium.** Attachment uses `readSlashCommands` in `agent-session.ts`;
refresh uses another `readSessionCommands` in `http.ts`, losing scope metadata.
Both concatenate templates, skills, and extensions. The installed SDK executes
extension commands before template expansion, so a duplicate name cannot be
resolved by picker group order. Extensions can finish without a model turn;
that must still produce a durable command outcome.

The prompt route deliberately uses `source: "rpc"`; arbitrary interactive
extension UI is not automatically supported. Do not set a misleading interactive
mode to make a command appear to work. The global list advertises `/compact`,
but the session list does not include it, the SDK prompt path does not implement
interactive builtins, and the bridge separately exposes a compact action.
That action is the right basis for an Orkestrator shortcut.

Evidence: [Pi discovery](../../bridges/pi-bridge/src/agent-session.ts),
[refresh and compact routes](../../bridges/pi-bridge/src/http.ts),
[prompt dispatch](../../bridges/pi-bridge/src/prompt.ts).
Pi's [extension docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
separate prompt-invocable commands from interactive built-ins. Newer extension
APIs such as `pi.getCommands()` are not necessarily methods on `AgentSession`;
use the pinned session/resource APIs rather than assuming interchangeability.

### F11 — Grok drops the standard ACP argument hint

**Priority: medium; small fix.** `available_commands_update` reads
`candidate.inputHint` and `candidate.argumentHint`, but the standard ACP field is
`candidate.input.hint`. Persisted catalogues and the UI therefore lose a useful
argument hint even when the provider sends it. Full-list replacement and
persistence already exist and should be retained.

Evidence: [ACP normalization](../../bridges/acp-bridge/src/acp-session.ts),
[persistence](../../bridges/acp-bridge/src/acp-persistence.ts).
The [ACP slash-command contract](https://agentclientprotocol.com/protocol/v1/slash-commands)
specifies dynamic inventories, nested input hints, and invocation as ordinary
`session/prompt` content. Grok's refresh route currently returns success without
requesting a fresh command list; report that limitation truthfully.

### F12 — Cursor support must remain evidence-gated

**Priority: retain existing limit.** Both Cursor catalogue routes intentionally
return `[]`, and its provider slash capability is false. No provider discovery
or dispatch contract was identified in the installed integration. Public
editor documentation is not evidence that `@cursor/sdk` executes editor
commands. Keep supported Orkestrator actions independent of this capability.

Evidence: [Cursor routes](../../bridges/cursor-bridge/src/http.ts),
[capabilities](../../packages/protocol/src/native-agent.ts).
This is a statement about the inspected integration, not a claim that Cursor
can never expose such an API.

### F13 — Prompt shaping can alter command interpretation

**Priority: high.** The composer adds attachment references, serializes mentions,
and appends annotations before checking provider commands. It blocks known
provider commands during pending agent handoff, using the currently displayed
catalogue. Backend workflow dispatch sets `allowProviderCommands: false`, but
the HTTP bridge prompt body does not propagate that flag. Codex only bypasses
its local command resolver for structured output; Pi enables expansion on its
SDK prompt path. The opt-out is therefore not a uniform provider contract.

Classify intent before prompt augmentation. Keep original text, argument suffix,
attachments, and command selection separate. Carry command/literal intent
through durable queues and dispatch records. Explicitly test workflow prompts,
handoff, annotations, images, restart, and ambiguous acceptance; never convert
a retry from command execution to a normal prompt.

Evidence: [composer submit](../../apps/web/src/components/native-agent/AgentNativeTab.controller.tsx),
[backend prompt dispatch](../../apps/backend/src/core/native-agent-service-prompt.ts),
[HTTP send](../../apps/backend/src/core/http-bridge-provider.ts),
[Codex prompt](../../bridges/codex-bridge/src/app-server-runtime-prompt.ts),
[Pi prompt](../../bridges/pi-bridge/src/prompt.ts).

### F14 — UI selection does not retain command identity

**Priority: medium.** Selecting a row replaces the draft with `name + space`.
There is no distinction between selected command and coincidentally matching
text. Filtering ignores descriptions/aliases, terminates only on a space, and
tracks an index rather than a stable ID. Refreshes can change which row an
index refers to. The menu returns nothing for an empty result, so a failed
catalogue looks like missing functionality.

Preserve the chosen identity while its command token remains unchanged; clear
it on token edits or session/provider changes. Keep argument edits intact.
Expose loading, unavailable, stale, and no-match states. Support accessible
keyboard selection without submitting on selection, and never auto-execute on
refresh or focus restoration.

Evidence: [hook](../../apps/web/src/hooks/useSlashCommandMenu.ts),
[menu](../../apps/web/src/components/chat/SlashCommandMenu.tsx).

## Proposed architecture

The existing route remains:

`provider inventory → bridge/provider adapter → backend snapshot → composer`

Execution becomes:

`user intent → authoritative command resolution → existing durable dispatch or
session action → provider-specific executor → authoritative outcome/transcript`

Separate these concepts:

| Concept | Purpose |
| --- | --- |
| Public descriptor | Stable ID, display/insertion text, aliases, description, provenance, availability, execution category |
| Private binding | Native command name, skill path, template identity, or supported action; never client-supplied authority |
| Catalogue snapshot | Generation/revision, freshness, completeness/truncation, bounded descriptors, refresh result |
| Invocation intent | Explicit selection or typed resolution versus literal message; original text and separate arguments |
| Execution record | Request ID, resolved command identity, prepared/dispatched/outcome state using existing dispatch ownership |

Use execution categories such as provider prompt, provider command API,
structured skill, bridge template, and session action. These describe routing,
not arbitrary executable code. Preserve namespaced and case-sensitive provider
names. Support literal messages without interpreting every leading filesystem
path as a command. A selected stale/disabled command fails before dispatch;
unrecognized ordinary text can still be sent deliberately as text.

Initial shortcuts should reuse `/steer` and existing compact controls. Defer
clear/new-session, model/permission changes, sharing, authentication, goals,
and generic editor navigation until their semantics are separately qualified.
Do not alias `/clear` to destructive history deletion, or `/review` to a
workflow that has different scope from the provider command.

## Delivery and open decisions

Deliver protocol and dispatch identity first, then provider fixes, then the
composer. Keep wire changes additive and negotiate enhanced execution; an old
bridge must not silently receive a new selected command as plain text.
Deprecate legacy discovery routes only after the mixed-version window is
specified and tested. No dependency upgrade is required merely to start.

Resolve these questions with bounded probes before enabling affected entries:

- Which Claude built-ins return text only, change settings, or change session
  identity under the pinned query lifecycle? Which settings must a probe share?
- Which OpenCode catalogue metadata and alias fields exist in `1.18.31`?
  How do command defaults interact with explicitly selected agent/model values?
- Which Pi extension commands are usable headlessly, and how can unsupported
  interaction be reported without assuming the SDK supplies a metadata flag?
- Can Grok refresh inventory without an active provider session? ACP provides
  push updates; do not invent a portable list RPC.
- Should the UI insert Codex `$skill` text or an Orkestrator `/skill:name`
  shortcut? Recommended: a slash picker may select a skill, but insertion uses
  `$name` and retains its explicit descriptor ID. Keep old slash spellings only
  as tested compatibility aliases to that same binding.
- Should inline-shell template compatibility survive? Recommended default:
  disabled. Any retained execution path needs a separate policy-reviewed design.

Completion means every enabled row has a tested executor, results survive
inactive environments and restart/reconciliation, and command failure never
silently changes into a model prompt. See the
[12-step plan](slash-commands/plan/00-index.md) for file ownership, acceptance
criteria, failure cases, dependencies, and rollout gates.
