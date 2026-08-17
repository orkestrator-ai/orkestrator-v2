# Platform inconsistencies

Status: analysis only. No implementation in this document's originating change.
Recorded 2026-08-16 from a read-only inventory of the six agent surfaces.

The six surfaces compared:

| Surface | Label in UI | Integration |
| --- | --- | --- |
| Claude Native | Claude Code (native) | `bridges/claude-bridge/` wrapping the Claude Agent SDK |
| Claude Tmux | Claude Code (tmux) | Claude Code CLI under tmux; `apps/backend/src/core/tmux-*.ts` |
| Codex Native | Codex | `bridges/codex-bridge/` speaking JSON-RPC to `codex app-server` |
| Cursor Agent Native | Cursor Agent | `bridges/acp-bridge/` ACP JSON-RPC over stdio (`ACP_PROVIDER=cursor`) |
| Grok Build Native | Grok Build | Same ACP bridge (`ACP_PROVIDER=grok`) |
| OpenCode Native | OpenCode | No Orkestrator bridge; backend drives `opencode serve` via SDK v2 |

Five native platforms share `AgentNativeTab` and the single capability table in
`packages/protocol/src/native-agent.ts` (`nativeAgentCapabilities()`). Claude
Tmux is a parallel product: it reuses chrome (`NativeComposeDock`,
`NativeMessage`, chat-find) but not the capability table, session actions, or
native-agent dispatch.

The table is honest for **UI gating** of the five native agents. It does not
describe Tmux, and it hides Cursor vs Grok spawn, MCP, subagent, usage, and
credential differences that live entirely below that table.

Primary sources:

- `packages/protocol/src/native-agent.ts`
- `apps/web/src/components/native-agent/`
- `apps/web/src/components/claude/ClaudeTmuxChatTab.tsx`
- `apps/backend/src/core/native-agent-service-*.ts`
- `apps/backend/src/core/tmux-*.ts`
- `docs/technical-architecture/agent-engines.md`

---

## 1. How the six stacks relate

| | Claude Native | Claude Tmux | Codex | Cursor | Grok | OpenCode |
| --- | --- | --- | --- | --- | --- | --- |
| Transport | claude-bridge + SDK | tmux PTY + hooks | app-server JSON-RPC | ACP stdio | ACP stdio | `opencode serve` SDK |
| UI | shared native tab | `ClaudeTmuxChatTab` | shared native tab | shared | shared | shared |
| Process | bridge + per-turn SDK | one tmux pane / tab | **1 child / env** | **1 child / session** | **1 child / session** | vendor HTTP server |

`nativeComposerControls()` builds controls from composer **state**, not from the
capability table. The native tab does not render that generated array; it
rebuilds the compose bar from `composer` plus a few adapter flags. Agent Info is
a third gate and often checks `provider === "claude"` rather than
`capabilities.actions.*`.

Features the capability table does **not** cover (gated by provider string,
projection payload, or product-level agent lists): questions, approvals, context
usage, chat-find, interrupt, @mentions, auto-title, plan-mode card, build
pipeline, looped review, multi-review.

---

## 2. Feature matrix

Values: **full** = capability/product list + UI + dispatch + provider path
verified. **partial** = present but weaker, different, or vendor-dependent.
**none** = gated off. **n/a** = not on that surface.

| Feature | Claude Native | Claude Tmux | Codex | Cursor | Grok | OpenCode |
| --- | --- | --- | --- | --- | --- | --- |
| File attachments | full | **none** (image paths typed into pane) | none | none | none | full |
| Images | full (SDK blocks) | **partial** (workspace path prose) | full | full | full | full |
| Queue | full (backend) | full (own `PromptQueueDrainer`) | full | full | full | full |
| Resume | full | full (own picker + `--resume`) | full | **partial** (410 if no `loadSession`) | **partial** | full |
| Fork | full | **none** | full | none | none | full |
| Slash commands | full (discovered) | **partial** (hardcoded TUI list) | full | none | none | full |
| Background tasks UI | full | **none** | none | none* | none | none |
| Model | full | full (`/model` into TUI) | full | full | full | full |
| Reasoning | full | full (`switchEffort`) | full | full | full | full |
| Fast / speed | full | full (`switchFastMode` / `/fast`) | full | partial | partial | **none** |
| Build / plan mode | full | full (`permission_mode`) | full | full | full | **none** (agents, not modes) |
| Execution profile | full (Agent Info) | **partial** (`/agents` TUI only) | none | none | none | full |
| Local settings / prompt suggestions | full | **none** | none | none | none | none |
| Compact | full | **partial** (`/compact` typed) | full | none | none | full |
| Rewind files | full | **none** | none | none | none | none |
| Undo / redo / share | none | none | none | none | none | **full** |
| Steer | none | none | **full** | none | none | none |
| Native “Review changes” | none | none | **full** | none | none | none |
| Questions | full | full (own cards) | partial | partial | partial | full |
| Tool approvals | **fail-open** in build | **fail-closed hooks** | fail-closed | fail-closed cards; CLI `--force` | `--always-approve` | full |
| Plan-exit UI | plan-approval card | own plan card | `CodexPlanModeCard` | permission/mode | permission/mode | none |
| MCP elicitations | UI exists, unused | **full** | Codex interactions | none | none | none |
| Interactive TUI overlay | none | **unique** | none | none | none | none |
| TUI selection prompts | none | **unique** | none | none | none | none |
| Context usage | full | partial (pane/transcript parse) | full | partial | partial | full |
| Chat-find / @mentions / interrupt | full | full | full | full | full | full |
| Auto-title | partial | env rename only | **full** (hermetic `codex exec`) | partial | partial | partial |
| Close vs destroy | **DELETE rollout** | stop pane; transcript **kept** | unsubscribe, never delete | kill child | kill child | **DELETE session** |
| Build pipeline / looped review | full | **n/a** (forced native) | full | full | full | full |

\*Cursor still runs background Tasks and the ACP bridge continues the parent
turn (up to four continuation prompts). There is no Claude-style hold/stop card.
Grok lets the parent go idle with live children and reports `/activity` as
`working` while `activeSubagentToolIds` is non-empty.

Cursor/Grok resume is partial because the table and UI advertise it, dispatch
calls `/session/list` + `/session/resume`, but ACP returns **410** when the
vendor does not announce `session/list` **and** `loadSession`. That is “unknown /
not exposed by this agent build”, not “Orkestrator forbids it”.

Cursor/Grok speed is partial: the table says `speed: true`; the toggle only
appears if the ACP composer reports `fastModeAvailable`. That pairing is
deliberate and was kept — both agents really do own a fast surface (Cursor a
`model_config` config option, Grok a sibling `…-fast` model id), it is just
per-agent-build rather than per-platform. The flag means “this platform may
offer it”.

OpenCode mode **was** partial: the table inherited `mode: true`; projection
injected Build/Plan; send mapped `mode` onto OpenCode’s **agent** field
(`executionAgent ?? mode`). That is not Claude/Codex permission-mode, so
OpenCode is now `composer.mode: false` and the dropdown is gone. Its execution
profile picker is the real control and already lists the primary agents. Before
the provider session exists, the launcher offers the built-in Build and Plan
agents as execution profiles and persists that choice separately from
conversation mode, so the opening prompt runs under the selected agent too.

`composer.provider` is `true` in the rich default for every native platform, but
a locked native tab never offers a platform switch. Only OpenCode’s model ids
are a real provider catalogue.

---

## 3. Discrepancies that matter

### 3.1 Claude Native vs Claude Tmux

Same product label, two permission models, two close/resume stories. This is the
largest user-visible split.

**Native build mode auto-approves tools** (`permissionMode: "bypassPermissions"`
plus `allowDangerouslySkipPermissions`). The user sees questions and plan-exit,
not Bash/Edit cards. Ordinary Read/Edit/Write/Bash/MCP tools do not wait for a
human.

**Tmux intercepts PreToolUse / PermissionRequest / Elicitation via hooks** and
fail-closes on timeout, overflow, or missing reply
(`failClosedHookResponse` in `tmux-hooks.ts`). It also has plan cards, permission
cards, elicitation cards, and TUI selection prompts.

A user who switches the Claude backend from Tmux to Native silently loses
per-tool approval.

Native-only Claude features Tmux does not have: fork, rewind-files, prompt
suggestions, local-settings toggle, background-task hold/stop, SDK file
attachments, discovered slash/plugin commands.

Tmux-only: interactive terminal overlay, pane selection prompts, hook-based
elicitations, `/config` `/login` `/mcp` as literal TUI commands.

**Close semantics also diverge.** Closing a native Claude or OpenCode tab
**deletes** the vendor session (`teardown_tab` → `DELETE /session/:id`). Closing
Tmux **stops the pane** and leaves the JSONL, so resume still works. Codex is
the third model: unsubscribe, never `thread/delete`.

Tmux queue drain used to live behind a mounted React tree. `PromptQueueDrainer`
now owns claim → submit → acknowledge server-side. Remount hydrates from
`getStatus` + `getTranscript` + `getPendingHooks` because live events only reach
mounted listeners. That matches the background-reliability rule; the interactive
terminal overlay is the remaining unmount-sensitive path.

Tmux attachments are not an attachment channel. An image is saved in the
workspace and its path is typed into the pane as prose
(`buildTmuxPromptWithAttachments`). Files are not offered; the compose hint is
“Paste an image into the input to attach it”.

Tmux slash commands are a **fixed list forwarded as literal text**
(`TMUX_BUILTIN_SLASH_COMMANDS` in `ClaudeTmuxChatTab.parts.tsx`). There is no
SDK discovery. Custom user/project commands still work if typed manually.
Compact, fast, and model changes are TUI commands (`/compact`, `switchFastMode`,
`switchModel`), not `performSessionAction`.

Tmux cannot drive a build pipeline, looped review, or multi-review. Launchers
force `mode: "native"`.

### 3.2 Cursor vs Grok

The capability table treats them as identical. Runtime is not.

| | Cursor | Grok |
| --- | --- | --- |
| Binary | `cursor-agent` (never `cursor`) | `grok` |
| Subcommand | `acp` | `agent … stdio` |
| Command auto-approve | `--force` | `--always-approve` |
| MCP auto-approve | `--approve-mcps` only if `ACP_APPROVE_PROJECT_MCPS === "1"` | **no equivalent flag** |
| Spawn `--model` | yes | yes |
| Spawn `--reasoning-effort` | **no** | yes |
| Composer wire | `session/set_config_option` (`model`, `thought_level`, fast) | `session/set_model` + `_meta.reasoningEffort` |
| Fast | config option / sibling model id | sibling model id (`…-fast`) |
| Subagents | parent HTTP held + continuation (up to 4) | parent may idle; activity stays `working` |
| Usage | adapter often silent | `_meta` / turn completed |
| Credentials | `CURSOR_API_KEY` | `~/.grok/auth.json` bind |

`--always-approve` on Grok is **not** environment-gated. Cursor’s `--force` is
always on; MCP is the extra lock and is pinned to `"0"` for local worktrees.
Only Cursor **containers** opt into `--approve-mcps`. `session/new` and
`session/load` always pass `mcpServers: []`; agents load their own project MCP
configs. Cloning a repository must not be enough to run its MCP on the host.

Fork, slash, compact, and file attachments are advertised **off** and really
absent. Orkestrator never calls ACP equivalents — unknown whether the vendors
expose them. Do not claim the vendor lacks `session/fork` from this inventory.

`backgroundTasks: false` understates Cursor: Tasks exist, they just are not
Claude’s stoppable-task UI. Grok notifies through `subagent_finished`.

ACP is the only native path with `POST /session/:id/attach`, so spawn sits
outside the at-most-once window. There is no idle-detach of live ACP children
(unlike Codex `thread/unsubscribe`). Re-attach happens after crash, DELETE, or a
child that already exited.

### 3.3 Composer flags that overclaim

- `composer.provider: true` for everyone; a locked tab never switches platform.
  Only OpenCode’s `provider/model` ids are a real catalogue.
- ~~OpenCode `composer.mode: true` injects Build/Plan, then sends that as the SDK
  **agent** name.~~ **Fixed:** OpenCode is `composer.mode: false`, so
  `projectionComposer` no longer injects the pair and `updateProjectionControls`
  rejects a mode patch (its guard reads the projected `modes` list). Both
  OpenCode catalogues also report `supportsMode: false`.
- Cursor/Grok `speed: true` even when the vendor build has no fast option; UI
  hides via `fastModeAvailable`. **Kept deliberately** — both agents do own a
  fast surface, so the flag is “may offer” and the composer decides. This is now
  stated in the table and asserted in `native-agent.test.ts`.
- ~~Speed is not gated by `capabilities.composer.speed` in projection.~~
  **Fixed:** `projectionComposer` ands the table into `fastModeAvailable`, which
  closes the latent leak at the surface the compose bar actually reads. The
  unassigned composer ands it into the catalogue's `supportsSpeed` too.
- Agent Info still hardcodes `provider === "claude"|"opencode"|"codex"` for
  rewind / undo / share / review / steer instead of `capabilities.actions.*`.
  Compact and fork *do* read the capability flag, with a provider-string
  fallback if projection is missing.
- ~~`nativeComposerControls()` never reads the capability table.~~ **Fixed:** it
  now takes capabilities as a required argument and skips speed / mode /
  execution-profile / local-settings / prompt-suggestions when the flag is
  false. The native tab still does not consume `composerControls`; that half of
  §4.1 is open.
- ~~Execution profiles are copied onto the projection whenever the provider
  reports them.~~ **Fixed:** `projectionComposer` gates both
  `executionProfiles` and `selectedExecutionProfileId` on
  `composer.executionProfile`, matching how local settings and prompt
  suggestions were already handled.
- **Still open, same class:** the Build/Plan default is injected for any platform
  whose table says `mode: true` but whose provider publishes no `modes`. That is
  correct for Claude (mode rides on the prompt as `permissionMode`) and Codex
  (mode lives in `/session/:id/config`), because neither bridge publishes a
  `modes` array. It is wrong for ACP: `composer.modes` there is derived from the
  vendor's `availableModeIds`, so an agent build that announces none still gets a
  dropdown whose selection `buildConfigCalls` silently drops. Fixing it needs a
  way to distinguish "provider does not own this list" from "provider owns it and
  says it is empty" without flickering the control off while an ACP session's
  config is still being restored (`acp-persistence.ts` starts at
  `availableModeIds: {}`).

### 3.4 Session-action islands

Each native platform grew unique Agent Info verbs and never back-ported them:

| Platform | Unique verbs |
| --- | --- |
| Claude Native | rewind files, background tasks, local settings, prompt suggestions |
| Codex | steer (`turn/steer`), native review (`review/start`), `CodexPlanModeCard`, hermetic titles |
| OpenCode | undo (`session.revert`), redo (`unrevert`), share / unshare |
| Cursor / Grok | none (`actions: {}`; `performSessionAction` throws) |
| Claude Tmux | none of those APIs; compact/fast/model are TUI keystrokes |

Users switching agents therefore lose verbs, not just models.

Codex native review is **not** looped-review. Agent Info always sends
`{ type: "uncommittedChanges" }` even though the bridge accepts `baseBranch` /
`commit` / `custom`. Compact `modelId` is accepted on the action type but Codex
`POST /compact` has no body.

### 3.5 Attachments

| | Files | Images |
| --- | --- | --- |
| Claude Native, OpenCode | yes | yes |
| Codex, Cursor, Grok | no (400 / toast) | yes |
| Tmux | no | path typed into the pane, not an image block |

The attachment **menu** still offers “Attach file from workspace” on image-only
agents, then toasts “This agent does not accept file attachments”. Dispatch does
not re-check the capability table (`dispatchPromptInternal` accepts any
attachments; `assertValidPromptAttachments` checks shape, not platform). A
queued file on Codex/Cursor/Grok would not be rejected by the shared service
layer. ACP strips inline `dataUrl` for cursor/grok and sends images as workspace
paths only.

@mentions are UI-only on every platform: `@filename` becomes
`[@file](relativePath)` and is sent as prompt text, not a native resource block.

### 3.6 Reliability and teardown

- **Codex** is the gold standard: generations, durable dispatch journal, idle
  detach, SSE cursor (subscribe before replay; `connected` echoes the client
  cursor), `/activity` never 404s, never `thread/delete`, approvals fail-closed
  including dead generations. One child serves every Codex tab and build phase
  in the environment.
- **Claude native** has **no attach warmup**; cold `query()` sits inside the
  at-most-once window. The dispatch journal is process-local and dies with the
  bridge, so a post-restart retry **will** run again (by design for a per-turn
  SDK child). SSE matches the Codex cursor contract.
- **ACP** has `/attach` (the only platforms that do) and a 4× session-create
  retry. Journal is in-memory. `/activity` is side-effect-free; unknown session
  is `{activity:"missing"}`. Stderr is drained, never logged.
- **OpenCode** has **no Orkestrator SSE**; the live tab polls snapshots (500 ms
  running / 1500 ms idle). Inactive tabs do not poll; remount reads the backend
  snapshot. At-most-once is transcript-marker based, not a durable bridge
  journal. Tab close **HTTP DELETE**s the vendor session.
- **Tmux** events only reach mounted listeners. Remount hydrates from status /
  transcript / pending hooks. Queue drain is backend-owned. Interactive terminal
  detach is environment-scoped.

Parked dispatch blocks the whole native session, not one prompt. UI must offer
retry-under-the-same-id or discard. `/dispatch?requestId=` answers `dispatched`
only on an explicit journal positive; `unknown` must never be treated as “never
sent”.

### 3.7 Product workflows

Build pipeline, looped review, and multi-review accept all **five** native
platforms once enabled (`BUILD_PIPELINE_AGENTS` / `LoopedReviewAgent` /
`AgentPlatform`). **Tmux cannot drive any of them** — launchers force
`mode: "native"`.

Legacy `enabledAgentPlatforms` still defaults to Claude/Codex/OpenCode
(`LEGACY_ENABLED_AGENT_PLATFORMS`), so Cursor/Grok pipeline/review is opt-in
even though the protocol lists them.

ACP structured output for looped/multi review is prompt-injected JSON, not a
native schema API. Cursor/Grok can be reviewers; reliability is weaker than
Claude/Codex/OpenCode schema paths.

Environment rename from the first prompt exists on the shared native tab and on
Tmux (including the backend queue drainer for still-generated timestamp names).

---

## 4. Table-vs-implementation mismatches (native only)

These are places the capability table, projection, and UI disagree. They are
cheap to fix relative to vendor protocol work.

1. ~~`nativeComposerControls` ignores the capability table~~ — **fixed**; it now
   takes capabilities. The native tab still ignores `composerControls`, so
   §5.1(6) (render it or stop generating it) remains open.
2. ~~Projection injects Build/Plan whenever `composer.mode` is true, including
   OpenCode~~ — **fixed for OpenCode** via `composer.mode: false`. Still open for
   an ACP build that publishes no `modes`; see the last bullet of §3.3.
3. ~~Speed is not gated by `capabilities.composer.speed`~~ — **fixed** in
   `projectionComposer`, `nativeComposerControls`, and the unassigned composer.
4. ~~Execution-profile / local-settings / prompt-suggestions: table vs compose bar
   vs Agent Info vs generator are three different gates.~~ **Mostly fixed** — the
   projection and the generator now share the table's gate. Agent Info is the
   remaining separate gate; it still ORs the provider string against
   `composer.executionProfiles` (§5.1(5)).
5. `composer.provider: true` for everyone; native picker is
   `platformSelectionLocked`.
6. Resume advertised for ACP even when the vendor cannot list sessions (410).
7. Agent Info dual-gates on provider string, not only capabilities.
8. Slash menu is wired for every native tab; `slashCommands: false` only empties
   the list.
9. Attachment capability is UI-only; dispatch does not re-check the table.
10. Codex-only `CodexPlanModeCard` vs shared `kind === "plan-approval"` card —
    same product idea, two UIs. Not a table bug (`plan-mode-card` is not in the
    table).
11. `prompt-queue-sources.ts` lists `claude`, `codex`, `opencode`, `claude-tmux`
    only. Native Cursor/Grok queue through projection storage. Table `queue:
    true` is honored on the native path; the old per-store sources are a
    parallel Claude/Codex/OpenCode/Tmux path.

---

## 5. Suggestions

### 5.1 Cheap — table and UI alignment

1. **Done.** Capabilities are passed into `nativeComposerControls`, which skips
   speed / mode / executionProfile / localSettings / promptSuggestions when the
   flag is false. The same gates were applied to `projectionComposer`, because
   the compose bar reads `composer` directly and never reads the generated
   array — gating only the generator would have changed nothing a user can see.
   OpenCode no longer gets an injected Build/Plan.
2. **Done.** OpenCode is `composer.mode: false`; execution-profile pickers are
   its only agent selectors. The pre-session picker carries Build/Plan into
   durable session controls, while the connected-session picker lists every
   primary agent the SDK reports. Two consequences of flipping the flag are
   handled in `projectionComposer` rather than left to the user:
   - A session created before the flip still holds `controls.mode`, and that
     value was already being dispatched as the SDK `agent` name. It is projected
     as the execution profile, so an upgraded session keeps running the agent
     the user picked instead of silently dropping to the provider default.
   - The pre-session picker cannot know the real agent names, so a pinned id is
     reconciled against the profiles the provider reports and dropped when that
     list is non-empty and omits it. An *empty* list means the agent listing
     failed or has not arrived, so the stored id survives there — discarding it
     on a transient read would swap the user's agent for the default.
3. Set `composer.provider: false` except OpenCode, or document it as
   launch-dialog only.
4. **Decided: keep the flag as “may offer”.** Cursor and Grok both really do own
   a fast surface, so `composer.speed: false` would have removed a working
   control. Table `true` is no longer treated as “always show” anywhere: every
   speed path now requires the table *and* a live `fastModeAvailable` /
   `supportsSpeed`.
5. Gate Agent Info rewind / undo / share / review / steer / localSettings on
   `capabilities.actions` / `composer.*`, and drop the `?? provider === …`
   fallbacks.
6. Stop generating `composerControls` the renderer ignores, or actually render
   that array in `NativeComposeBar` so table → generator → UI is one path.
7. Gate `useSlashCommandMenu` on `capabilities.slashCommands` (plus injected
   `/steer`).
8. Resume button for ACP: if `/session/list` 410s, hide/disable with the bridge
   reason rather than leaving a dead Resume control.
9. Re-check attachments in dispatch against `nativeCapabilities(agent).attachments`
   so queue/retry cannot send files the table forbids.
10. Change the native attachment menu copy on image-only agents so it does not
    offer workspace files.

### 5.2 Shared surface that already exists — wire it, don’t invent RPCs

Queue, resume (when the vendor lists sessions), interrupt, chat-find, @mentions,
model/reasoning pickers, interaction cards, and parked-dispatch retry/discard
are already shared. Remaining cheap product work:

- Surface OpenCode undo / redo / share in transcript chrome, not only Agent
  Info.
- Keep steer / native review as Codex-only unless another provider grows
  `actions.steer` / `actions.review`.
- Put compact on a slash or overflow for Claude/Codex/OpenCode (Tmux already
  types `/compact`).
- Do **not** put Tmux on `nativeAgentCapabilities` until it has a real bridge;
  the table would lie the other way.

Already on the shared action bus (`performProjectionAction` /
`NativeAgentSessionAction`): compact, rewind-files, undo, redo, share, steer,
review. Cheap work is UI wiring, not new vendor RPCs.

### 5.3 Needs vendor protocol work

| Feature | Blocker |
| --- | --- |
| Cursor/Grok fork | Not exposed on the ACP bridge. Do not claim the vendor lacks `session/fork`. |
| Cursor/Grok slash discovery | Bridge returns `[]`. Unknown whether Cursor/Grok ACP has a command list. |
| Cursor/Grok session actions | Provider rejects all. Compact/steer/review would need ACP methods. |
| Cursor/Grok resume | Needs vendor `session/list` + `loadSession`. |
| Cursor/Grok speed | Needs vendor config option / `supportsSpeed`. |
| Cursor background-task UI | Tasks already run; a hold/stop card would be product work on existing continuation. |
| OpenCode conversation mode | SDK has agents, not Claude-style permission mode. Don’t fake it with Build/Plan. |
| ACP structured review | Works via prompt injection; a real schema channel would be vendor work. |
| File attachments on Codex/ACP | Table says files false; enabling needs the vendor to take file content blocks. |
| Background tasks | Claude SDK only. |
| Prompt suggestions / local settings | Claude bridge only. |
| Native Claude attach warmup | Mirror ACP `/attach` so spawn sits outside the at-most-once window. |
| Native Claude close-without-delete | Match Codex unsubscribe if resume-after-tab-close is a product goal. |
| Session titles | Codex is the only dedicated generator (`session-titles.ts`). Others get whatever the vendor puts on `title`. |
| Tmux rewind / fork / prompt-suggestions | Those are SDK APIs; Tmux would need a different design (or stay unique). |

### 5.4 Claude Tmux: converge chrome, keep the engine separate

**Keep separate:** PTY observer, hook approvals, interactive terminal, TUI slash
list, pane selection prompts. Pipelines and reviews should stay native.

**Worth aligning:**

- Permission story vs native Claude. Either document that Tmux asks and Native
  bypasses, or give native an optional “ask for tools” mode that Tmux already
  has.
- Close/resume: Tmux keeps transcripts; native deletes them. Pick one product
  rule for “close tab”.
- Compact as a first-class action in Tmux (it is already `/compact` text) so
  Agent Info matches native.
- Fork is the one native Claude verb users will miss most in Tmux; there is no
  tmux equivalent without SDK `forkSession`.

**Worth sharing as chrome only:** queue (already on `prompt-queue-sources`),
resume dialog chrome, @mentions, chat-find, interrupt, context wheel, compose
dock layout.

**Do not merge** hook cards into `NativeAgentInteractionCard` until the payloads
are the same type. They look similar and are not. Do not merge TUI
permission-mode toggling with native `permissionMode` on prompt.

### 5.5 Stay platform-unique

Do not fake these on platforms that lack the vendor method.

| Feature | Why it stays unique |
| --- | --- |
| Claude rewind-files | Claude SDK checkpoint; other vendors don’t expose the same worktree rewind. |
| Claude background tasks + hold card | Claude Agent Tasks; ACP/Codex/OpenCode don’t have this lifecycle. |
| Claude local settings + prompt suggestions | Claude-bridge session options. |
| Codex steer (`turn/steer`) + `/steer` | App-server method; injecting it for others would shadow provider commands. |
| Codex native review (uncommitted changes) | Thread review API; not looped-review. |
| Codex plan-mode card | Codex `planReview` transcript flag after plan turns. |
| Codex hermetic titles | Isolated `codex exec`; must not inherit user tools/config. |
| OpenCode undo / redo / share | OpenCode SDK `session.revert` / `unrevert` / `share`. |
| OpenCode execution profiles | OpenCode primary agents, not Claude subagents / Codex profiles. |
| OpenCode provider allowlist | Thousands of models; other platforms are single-catalogue. |
| ACP image-only attachments | Both ACP agents take inline image blocks, not files. |
| ACP `--force` / `--always-approve` | CLI contract. Cursor MCP approve is the intentional container exception. |
| Claude Tmux TUI slash / fast / compact | Those commands exist because the user is driving the CLI, not the SDK. |
| Claude Tmux interactive terminal + selection prompts | That is the point of Tmux. |

---

## 6. Suggested implementation order

If this analysis is turned into work, do not start with vendor protocol
research. Close the honesty gaps first.

1. **Document or align Claude Native vs Tmux permissions and tab-close.** Same
   label, different safety and resume story. Product decision before code.
2. **Stop overclaiming composer/resume flags.** OpenCode mode and the
   composer-control gates are done (§5.1(1)(2)(4)). Still open: ACP resume,
   `provider: true`, and the Agent Info provider-string fallbacks.
3. **Attachment honesty** (menu copy + dispatch re-check) for Codex / ACP /
   Tmux.
4. **Decide whether Cursor/Grok should grow compact / slash / fork** after
   checking ACP, or stay the slim pair they are today.
5. **Native Claude attach + close-without-delete** if we want Codex-class
   reliability on the richest agent.
6. **OpenCode undo/redo/share in transcript chrome** and stop treating Agent
   Info as the only home for platform-unique verbs.

The cheapest first PR is (2) + (3): capability-table and attachment-menu
alignment, no vendor work.
