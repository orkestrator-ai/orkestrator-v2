# Native-agent slash commands

Status: living. Owner modules:
[`agent-command-catalogue.ts`](../../packages/protocol/src/agent-command-catalogue.ts)
(wire contract, bounds, intent parsing) and
[`agent-slash-commands.ts`](../../packages/protocol/src/agent-slash-commands.ts)
(lexical parsing, resolution, session-action collisions). Outstanding work:
[0015-slash-command-qualification.md](../todo/cli-and-slash-commands/0015-slash-command-qualification.md).
The catalogue decisions below come from to-do 0016, retired on 2026-11-11
(its last version, with every option weighed, is
`git show 14df96544:docs/todo/cli-and-slash-commands/0016-slash-command-catalogue.md`).

Every enabled row in the native composer's `/` menu must run exactly what it
describes, through a tested executor, and a chosen command must never silently
become an ordinary model prompt.

A leading `!` is not a slash command: the composer runs it as a shell command
by the user before any command classification, and it never reaches the
provider. See [user-commands.md](user-commands.md).

## Descriptor

`NativeAgentSlashCommand` keeps its legacy display fields (`name`,
`description`, `argumentHint`, `source`, `aliases`, `scope`) and adds an
execution descriptor:

| Field | Meaning |
| --- | --- |
| `id` | Opaque, stable within one provider/environment/session authority. A lookup key, never a permission grant. |
| `insertText` | Exact text a picker inserts; defaults to `name`. `$name` for Codex skills. |
| `executionKind` | `provider-prompt`, `provider-command`, `structured-skill`, `bridge-template`, `bridge-local`, `session-action`. |
| `origin` | Verified ownership (`project`, `user`, `system`, `admin`, `plugin`, `orkestrator`, `unknown`). Absent or `unknown` when the provider does not say. |
| `availability` | `available`, or `unavailable` with an allowlisted `reason` and short `message`. Unavailable rows are listed but never executed. |
| `inputPolicy` | `arguments` (`none`/`optional`/`required`), `attachments` (`none`/`images`/`any`), `busy` (`queue`/`idle`/`running`). |
| `bindingRevision` | Changes when execution meaning changes (different skill path, template file, provider command), never for description edits. |
| `caseSensitive` | The provider distinguishes names differing only in case. |

`source` is picker grouping and provenance; it is independent of execution.
`scope` (`global`/`session`) is the row's lifetime, not ownership.

Private bindings — canonical provider names, skill paths, template files,
action kinds — live only in the executor's registry. The browser never sends
one, and no public payload contains a path or a template body.

## Bridge wire contract (catalogue version 1)

### Catalogue reads

`GET /session/:id/commands` on an enhanced bridge answers:

```json
{
  "catalogueVersion": 1,
  "status": "ready",
  "revision": 3,
  "generation": "g-1",
  "freshness": "push",
  "truncated": false,
  "commands": [
    {
      "name": "/review",
      "id": "claude:/review",
      "executionKind": "provider-prompt",
      "source": "project",
      "description": "…",
      "argumentHint": "<path>",
      "bindingRevision": "…"
    }
  ]
}
```

- `status` is `ready` (authoritative, including an empty list), `stale` (a
  retained list the bridge could not refresh), `unsupported` (this integration
  has no provider catalogue) or `missing` (the bridge does not hold the
  session). An enhanced bridge answers an unknown session **in band** with
  `missing`; a 404 means the bridge is older than this contract (it predates
  the route, or it is a pre-2.21 bridge that does not hold the session). So
  does an answer without `catalogueVersion`. The backend reports either as
  `unavailable` with the error code `outdated-bridge` and counts it; it never
  falls back to a global list.
- `attachPending: true` (with `status: "stale"` only) says the rows are what
  the bridge could read without starting the provider session, and the
  provider adds more commands once the session attaches (its first turn or an
  explicit refresh). The backend carries it onto the catalogue state, keeps it
  on rows retained through a failed re-read, and drops it from any list that
  is not `stale`; the picker adds "More commands load when the session starts;
  refresh to load them now." Pi is the only bridge that sends it.
- Enhanced rows without an `id` and `executionKind` are dropped. A bridge
  cannot mint a `session-action`; those are the backend's.
- Rows are bounded (see `COMMAND_CATALOGUE_LIMITS`): 512 rows, 256-byte names
  and ids, 16 aliases per row and 2,048 in total, 1,000-byte descriptions,
  512-byte hints, 512 KiB per response. Identity fields over their limit are
  rejected, never truncated into a different command.
- A catalogue read is metadata. It must not touch `lastAccessed`, hydrate a
  transcript, or re-attach an idle session.

### Push freshness

A bridge that tracks its own inventory revision publishes it as a top-level
integer `commandRevision` on the session snapshot the backend already reads
(`GET /session/:id` for Claude, `GET /session/:id/status` for the others),
from memory only. When it differs from the revision the cached catalogue was
read at, the backend revalidates in the background. That is how Claude's
`commands_changed`, Codex `skills/changed` and Grok's
`available_commands_update` reach a tab that was not mounted, without any
polling of a liveness-touching route.

### Refresh

`POST /session/:id/commands/refresh` answers `{ "outcome": …, "message"?: … }`
where `outcome` is `reloaded` (provider resources were reloaded), `reread`
(a cached/live list was re-read without reloading resources), `deferred`
(reload will happen when the session is idle), `unsupported`, or `failed`.
A bridge must not claim `reloaded` for a push-only provider.

### Prompt body

The existing prompt route accepts two additive fields:

- `allowProviderCommands: boolean` — `false` is literal intent. The bridge
  skips its own resolver (templates, local built-ins, skills) and uses the
  provider's suppression mechanism where one exists. Absent means "interpret"
  (legacy behaviour).
- `command: { id, name, executionKind, bindingRevision?, arguments }` — the
  descriptor the backend resolved against this bridge's own enhanced
  catalogue. The bridge looks `id` up in its private registry, checks the
  binding revision and availability, and executes that binding with
  `arguments` exactly as typed. If anything no longer matches it answers
  **HTTP 422** `{ "error": "…", "kind": "command-unavailable" }` before any
  journaling or side effect. It never falls back to sending the text as a
  prompt. `command` with `allowProviderCommands: false` is invalid (400).

The backend only sends `command` for descriptors that came from that bridge's
enhanced catalogue, so an older bridge is never handed a selection it would
ignore.

## Intent and resolution

A submission carries `NativeAgentCommandIntent`: `literal`, `typed`, or
`selected { commandId, bindingRevision? }`. Resolution
(`resolveCommandInvocation`) runs in the backend before any prompt shaping or
queue insertion; the composer runs the same function only as a convenience.

- Lexical parsing (`parseCommandToken`) finds the leading token without
  changing its bytes. The separator is the run of spaces/tabs after the token
  plus at most one line break; the argument suffix is everything after it,
  verbatim.
- Typed text: exact spelling, then case-folded spelling (unless
  `caseSensitive`), then aliases. More than one candidate is `ambiguous`.
  Unknown tokens and leading paths are ordinary text.
- A selection must still exist, match the typed token, and carry the same
  binding revision; otherwise it is a stale selection and the draft is kept.
- Known unavailable rows and argument-policy violations fail before dispatch.

Workflow, mail and structured-output prompts are literal. Providers whose SDK
interprets prompt text itself and has no suppression (Claude, Grok) refuse a
literal prompt whose leading token names a known command rather than running
it (`literalCommandSuppression`).

The public CLI sends explicit intent: `session prompt` and `session start`
carry `literal` only with `--literal` (otherwise the tab's typed default
applies), and `session command` always carries `selected` with the binding
revision the backend resolved at admission, so it is never re-resolved by
name ([public-cli.md](public-cli.md#sessions-and-runs)). A coordinator's
`run_worker_command` resolves and dispatches through the same functions
(`resolveSessionCommand`), so it is a selection with the same refusals; it
also refuses `/steer` and does not list it, since `send_message` with
`deliverNow` is the coordinator's way into a running turn
([coordinator.md](coordinator.md#worker-surfaces)).

## Session actions and collisions

The backend merges runtime actions into the provider list
(`withSessionActionSlashCommands`):

- `/steer` is **reserved** while steering is qualified: it acts on the live
  turn, and is offered only while one runs. When that turn ends (or another
  starts) before the steer reaches it, the backend sends the text as the next
  turn instead of refusing it: at once when nothing is running, through the
  prompt queue otherwise (`native-agent-missed-steer.ts`). When steering is
  unavailable a provider's own `/steer` is kept, not deleted.
- `/compact` **defers**: a provider that ships its own `/compact` (Claude's
  SDK) keeps it; otherwise the row runs the existing compact session action.
  The action takes optional instructions for the summary
  (`/compact <instructions>`) only where the platform advertises
  `actions.compactInstructions` (Claude, whose bridge sends the CLI's
  `/compact <instructions>`, and Pi, whose bridge calls
  `session.compact(customInstructions)`). There the row's argument policy is
  `optional` with hint `[instructions]`; on every other platform it stays
  `none`, so the text is refused rather than dropped. Codex
  `thread/compact/start` and OpenCode's `/api/session/:id/compact` take no
  instructions, and Grok's `/compact` input is unverified. Instructions reach
  the bridge as `POST /session/:id/compact` with `{ "instructions": "…" }`
  (bounded by `COMPACT_INSTRUCTIONS_MAX_LENGTH`), and a bridge that used them
  answers `instructions: "applied"`. A bridge that predates them compacts
  plainly; the backend reports that as `instructionsIgnored` on an applied
  outcome. Prompt dispatch also returns `instructionsIgnored: true` on its
  accepted response when it observes that acknowledgement. A same-id replay
  remains accepted without running compaction again; this advisory flag is not
  persisted and is absent on replay (see the
  [compatibility register](version-compatibility.md#register)).
  On Pi, Stop also ends a manual compaction: while it compacts the bridge
  reports `running` with `activity: "compacting"` (shown like Claude's
  compacting state), and with no prompt claim `/cancel`, `/abort` and
  `/hard-abort` call Pi's `abortCompaction()`. The compact route then answers
  409 `{ error, cancelled: true }`, so the composer says the compaction was
  stopped, keeps the draft, and the conversation is not compacted. Every Pi
  model also carries a session-scoped `autoCompaction` toggle ("Auto-compact",
  default Pi's own `compaction.enabled`). The bridge applies it by overriding
  the session's settings manager in memory and keeps it in its `state.json`,
  never in Pi's `settings.json`; the backend keeps it across a model switch.
  `bridges/pi-bridge/src/compaction-controls.test.ts` proves both on the real
  Pi SDK with the faux model.
- `/goal` is **reserved** on platforms with `actions.goal`: the backend's goal
  loop replaces a provider's own `/goal`, so two loops can never stack on one
  session. It has no `busy` policy: it neither queues nor interrupts a turn, it
  journals no request, and the composer calls it directly. See
  [goals.md](goals.md).
- `/subork` is **reserved** on platforms with `actions.subork` (every native
  platform). It needs a request and takes no attachments. Unlike `/goal` it is a
  turn: a busy agent queues it, and dispatch rewrites it to a literal carrier
  asking the current agent to call `ask_agents`, so a retry resends that text. It
  works in environment tabs and coordinator conversations, and is refused in a
  session Orkestrator runs itself (a pipeline worker, reviewer or subork) and
  while a handoff waits for its first message. See [suborks.md](suborks.md).

Deduplication is by identity, never by lower-cased display name.

No other shortcuts are planned beyond `/goal`, which has its own design
([goals.md](goals.md); decided 2026-10-24 in to-do 0016, retired),
and `/subork`, which has its own contract ([suborks.md](suborks.md)).
Clearing or starting a session, model and permission changes already have
composer controls, and a `/review` alias would run a workflow whose scope
differs from the provider's command. A new shortcut needs its own todo with
its semantics qualified.

## Provider support

Support was first qualified from installed SDK declarations and source and
exercised with transport-level fakes. It was then qualified live, against real
providers, at these pins:

| Provider | Pin | Live record |
| --- | --- | --- |
| Claude | Agent SDK 0.3.296 / CLI 2.1.296 | 2026-10-17: discovery, templates, local output, `/compact`, refusals, restart; browser scenario on a host worktree. 2026-10-23: browser scenario on a host worktree and in a container |
| Codex | app-server 0.162.1 | 2026-10-17: skills, templates, built-ins, refusals, restart; browser scenario on a host worktree. 2026-10-23: disabled skills; browser scenario on a host worktree and in a container |
| OpenCode | SDK and server 1.19.0 (1.x, retired 2026-11-11; 2.x observed on 2.2.6, see the provider notes) | 2026-10-17: discovery, `session.command`, refusals, reload |
| Grok | 1.0.52 / ACP SDK 1.8.0 | 2026-10-17: user skills, push updates, re-send after `session/load`; project skills after the folder-trust fix |
| Pi | SDK 1.2.0; pre-attach list on 1.4.0 | 2026-10-23: discovery, extension-before-template precedence, headless extensions, templates, literal opt-out, mid-turn refresh. 2026-10-25: templates listed before the first turn (todo 0069) |
| Cursor | SDK 1.0.37 | 2026-10-17: still `unsupported` |

The pins moved again on 2026-10-30 (Claude Agent SDK 0.3.314 / CLI 2.1.314,
Codex 0.166.0, OpenCode 1.19.5, Grok 1.0.70 / ACP SDK 2.1.0, `@cursor/sdk`
1.2.0; Pi unchanged at 1.4.0). Only the credential-free Codex disabled-skills
probe was re-run then (same result as 0.164.0). The other rows above are still
the live record at their own pins and are unproven at the new ones until a
signed-in run repeats them; the transport and fake-model suites pass at the
new pins.

The picker itself (source groups, keyboard order, a command file added on
disk reaching the menu after a refresh, the row surviving a reload) passed
live on Claude CLI 2.1.309, Pi 1.4.0 and Grok 1.0.67 on 2026-10-24, with no
model turn (`slash-command-picker.spec.ts`,
[agent-testing.md](../development/agent-testing.md#live-slash-command-picker)).

The record, including what each run did not cover (a backend restart,
and OpenCode, Grok and Pi in the browser scenario), is in
[0015-slash-command-qualification.md](../todo/cli-and-slash-commands/0015-slash-command-qualification.md).
Mocks do not confer support: a behaviour that could not be qualified is listed
unavailable with a reason. Re-qualify on every pin change
([`upgrade-agents.md`](../development/upgrade-agents.md#repository-wide-validation)).

| Provider | Discovery | Names | Execution | Catalogue status |
| --- | --- | --- | --- | --- |
| Claude | Live `supportedCommands()`, replaced by `commands_changed`; init names as cold fallback; a config-parity probe | SDK spelling and SDK aliases; skills annotated, no `/skill:` rows | `provider-prompt`: canonical name plus verbatim arguments through the query | `ready` only from the session's own query or a push; probe and init lists are `stale` |
| Codex skills | `skills/list` for the effective cwd | `$name`, alias `/skill:name` | `structured-skill`: `{type:"skill", name, path}` plus a text item | `SkillsListResponse.errors` make the list partial or stale; a child's list is `stale` until the second or later settling re-read agrees, or five rounds are spent |
| Codex templates | Bounded scan of `.codex/prompts` and `~/.codex/prompts` | Relative path | `bridge-template`: `$ARGUMENTS` expansion only | Scan errors reported as truncation |
| Codex built-ins | Bridge | `/help`, `/models` | `bridge-local` | — |
| OpenCode | One `GET /api/command` for the session's directory; refresh re-reads it | Exact server key, case-sensitive, no aliases | `provider-command` via `POST /api/session/:id/command` | List errors fail the read; an empty list stays empty |
| Pi | One builder over templates, skills and extensions (`sourceInfo` origin); before attach, the same builder over a resource-only read (templates and skills) | Template `/name`, skill `/skill:name`, extension invocation name | `provider-prompt` via `session.prompt({source:"rpc"})` | Before attach: `stale` with `attachPending` when the policy loads extensions, otherwise `ready`; a persisted list is `stale` after restart |
| Grok | ACP `available_commands_update` (push only) | Name as sent; `input.hint` as argument hint | `provider-prompt` via `session/prompt` | `ready` once this process received a list, even an empty one; restored rows are `stale` and not executable |
| Cursor | None | — | — | `unsupported` |
| Orkestrator | Backend | `/steer`, `/compact`, `/goal` | `session-action` | — |

### Unavailable commands

These are listed with a reason and never executed:

| Provider | Commands | Reason |
| --- | --- | --- |
| Claude | `/clear`, `/model`, `/permissions`, `/resume` | `session-changing`: the bridge does not adopt the new conversation ID, and each turn re-applies model and permission mode |
| Claude | Init `terminal_slash_commands` (before a session's first turn, the list the same CLI version reported on an earlier turn), `/login`, `/logout` | `requires-interactive-ui` |
| Claude | `/config`, `/doctor`, `/exit`, `/ide`, `/quit`, `/statusline`, `/terminal-setup`, `/theme`, `/vim` | `unqualified` |
| Codex | Duplicate skill names | `ambiguous` |
| Codex | Disabled skills (`[[skills.config]] enabled = false` in the user `config.toml`; 0.166.0, like 0.164.0 and 0.162.1, ignores the same entry in a project `.codex/config.toml`, trusted or not) | `disabled` |
| Codex | Templates named after a reserved command | `reserved-name` |
| Codex | Templates containing `` !`…` `` | `requires-shell-execution` |
| Codex | Templates with malformed frontmatter | `unsupported` |
| OpenCode | TUI controls (`/exit`, `/themes`, `/editor`, …) | Not in the catalogue; typed spellings get an explanation |

The Claude lists live in `bridges/claude-bridge/src/services/session-manager-commands.ts`.
The bridge also refuses typed text naming any of them, so a failed backend
catalogue read cannot let `/clear` reach the CLI.

### Literal suppression

| Provider | Mechanism | Limitation |
| --- | --- | --- |
| Claude, Grok | None in the SDK or ACP | The backend refuses a literal prompt whose leading token names a known command |
| Codex | Bridge resolver bypassed | app-server does not interpret `/` text |
| OpenCode | A plain prompt instead of the command route | — |
| Pi | `expandPromptTemplates: false` (covers extension commands, skills and templates) | Extension `input` handlers still run on every prompt. Pi always expands follow-ups, so a literal prompt Pi would read as a command is refused (409) while a turn runs instead of being queued |
| Cursor | No commands | — |

### Provider notes

- **Claude**: rows are the SDK's own names; `/skill:` is never synthesized.
  Session-changing (`/clear`, `/model`, `/permissions`, `/resume`),
  terminal-only and unqualified commands are listed unavailable, and the bridge
  also refuses them as typed text. The session-changing ones stay unavailable
  by decision: the composer's model and permission controls, a new tab and the
  session history already cover them, and running them through the CLI would
  replace the conversation the bridge tracks. Local command output is persisted as a
  transcript row. Only a turn's init frame names the terminal-only commands
  (`SlashCommand` has no marker), so the bridge remembers the newest list per
  CLI version (`claude-terminal-commands.ts`, persisted under
  `~/.claude/orkestrator/`) and applies it to probe rows until the session's
  own init arrives. A CLI version the bridge has never run a turn on gets no
  list: its terminal-only rows stay available, and the CLI answers them as
  local output, until that first turn. Holding every `builtin` row
  unavailable until then would also block `/context` and `/compact`, a fixed
  name list would rot with each CLI release, and a model turn at tab open
  would cost tokens and leave a session file nobody asked for. If the Agent
  SDK adds a terminal marker to `SlashCommand`, read it from the probe's rows
  and delete the remembered list; every SDK bump checks for it
  ([upgrade-agents.md](../development/upgrade-agents.md#how-to-upgrade-claude)).
  Still absent at 0.3.319 (the pin) and 0.3.322 (the newest published, checked
  2026-11-11).
- **Codex**: skills run as structured `skill` input (`$name`, alias
  `/skill:name`); templates are an Orkestrator compatibility feature with
  bounded discovery and `$ARGUMENTS` only. Inline `` !`…` `` shell spans are
  disabled for good: there is no shell executor for templates, and none is
  planned (skills are the supported way to run tools). `/help` and `/models`
  are bridge-local; reserved names cannot be shadowed by a template.
  app-server answers the first `skills/list` after it starts before its plugin
  skills have loaded, and sends no `skills/changed` when they arrive (0.164.0:
  26 skills for the first 100-300 ms, then 114). So each app-server
  generation's list is `stale` for at least two settling re-reads, each sent
  1 s after the preceding answer (`coldSettleMs` in
  `commands/skill-inventory.ts`). The second or later re-read must agree with
  the answer that armed its delay; an intervening explicit refresh cannot
  replace that baseline. A mismatch arms one more, up to `maxSettleReads`
  (five), after which the newest answer is trusted. A read already in flight
  when the timer fires never counts. Loads after this bounded observation
  window rely on notifications or the 30 s TTL. Settling bumps
  `commandRevision`; disposal cancels queued settling continuations. The
  delay was measured only on a host worktree on Apple Silicon; it is accepted
  for slower containers without a container figure, because a load that keeps
  changing extends the rounds and the only miss (a load that pauses for more
  than 1 s after two agreeing answers, then resumes) shows a short list that
  the first read past the TTL heals, never a guessed row
  (`codex-command-catalogue.test.ts`, "plugins that load after the list
  settled appear at the next TTL read").
- **OpenCode**: `GET /api/command` lists `{ name, description }` only for
  the session's directory (`opencode2/commands.ts`, with the registry and
  resolver in `opencode2/command-catalogue.ts`). A selection runs as `POST
  /api/session/:id/command { name, text, delivery: "queue" }`, which answers
  204 once the command's prompt is admitted (not when its turn ends); an
  unknown name is 404 `CommandNotFoundError`, a refusal. The expanded prompt
  carries no metadata, so an ambiguous command reads `unknown` afterwards and
  is never re-sent. Refresh re-reads the list (`reread`). Observed on 2.2.6.
  OpenCode expands templates on its own server, so a user's arguments to a
  template with `` !`cmd` `` spans can reach a shell there (observed on 1.x);
  Orkestrator adds no shell surface of its own. Until 2026-11-11 OpenCode 1.x
  listed commands through the SDK's `command.list` and reloaded a directory
  instance to pick up new command files (`git show
  5f4e27b1c:apps/backend/src/core/opencode-command-reload.ts`).
- **Pi**: extensions win over skills and templates, as in the SDK, and only
  the effective winner is listed. Before a session attaches, the bridge lists
  its templates and skills from Pi's own `DefaultResourceLoader` with
  extensions off (`command-preview.ts`): no extension module is imported, no
  `resolveProjectTrust` pass runs (trust comes from the execution policy), and
  a missing configured package is skipped rather than installed (the loader's
  `packageManager.resolve` is given a `skip` handler; pinned against the real
  SDK in `command-preview.test.ts`). Session create starts the read, and the
  first catalogue read waits up to 5 s for it; it never attaches or touches
  `lastAccessed`. The list is `stale` with `attachPending` when the policy
  lets extensions load, since extension commands and resources an extension
  adds through `resources_discover` exist only after attach. When the policy
  excludes extensions (host sessions without project resources, read-only
  sessions) nothing can add a command at attach, so the read is `ready`. Rows
  an attach read (live, kept across an idle detach, or restored) are never
  replaced by a preview, and an attach that lands first wins over a late one.
  A read that finishes while an attach is in flight, after its policy
  changed, or after the session closed is discarded; if that attach then
  fails, the next catalogue read reads again.
  A selection from a preview row is re-checked after the prompt route
  attaches, against the attached list and Pi's dispatch order, so a template
  an extension shadows is refused with 422, never run as the extension. Literal intent uses
  `expandPromptTemplates: false`, which cannot stop extension `input` handlers.
  `reload()` replaces the extension runner, including the approval gate, so
  refresh answers `deferred` while a turn runs and reloads when idle. SDK 1.2.0
  still has no guard of its own: `reload()` fires `session_shutdown`,
  invalidates the runner and resets the API providers, and Pi's terminal still
  refuses `/reload` while streaming. Extension commands wait for idle and take
  no attachments. Run headless they see `ctx.hasUI === false`, and every
  dialog answers at once with no answer (`confirm` is `false`; `select`,
  `input`, `editor` and `custom` are `undefined`) rather than blocking. That
  was checked live on 1.2.0 and is pinned against the real SDK runner
  (`extension-headless-ui.test.ts`, 1.4.0). Pi gives a registered command no
  way to say it needs a UI, so none is listed unavailable in advance; instead
  the turn always ends with an outcome row, and one that produced nothing says
  a command needing a dialog could not show one (`settleCommandRun`). The
  bridge never binds a UI context, so `hasUI` is never faked.
- **Grok**: push-only inventory. Grok may push its list before the session is
  attached on the bridge, so the bridge buffers the latest list and applies it
  on attach. A list restored from disk is `stale` and not executable until
  Grok reports it again.
- **Cursor**: `unsupported`; application actions such as `/steer` remain.

## Lifecycle

The backend caches one catalogue per environment, provider, runtime
generation and session (`NativeAgentCommandCatalogueCache`), with status `loading`, `ready`, `stale`,
`unavailable` or `unsupported` projected as `slashCommandCatalogue` next to
`slashCommands`. Failures keep the previous list as `stale` with a bounded
error code and retry backoff; they never become `ready: []`. Selected
commands are revalidated at dispatch, dequeue and retry.

A new tab has a provider session ID before its first turn: the renderer's
`ensureNativeAgentSession` creates the bridge session when the tab opens, and
a persisted mapping always carries `providerSessionId`. Until that lands the
projection is `null` and the picker shows nothing; afterwards
`HttpBridgeCatalogAdapter` reads `GET /session/:id/commands`. The Claude bridge
answers a session that has not run a turn from one control-only CLI probe
(`status: "stale"`) and the picker shows `loading` while the first read is in
flight, so a new tab only ever shows its own session's rows. The
probe sends no message (`controlOnlyQuery`): the Agent SDK drops
`maxTurns: 0`, so a `prompt: ""` probe used to start a real turn. The Pi
bridge answers one from a resource-only read of its templates and skills,
marked `attachPending` when extensions will add commands at attach (see the
Pi provider note).

There is no global catalogue. The legacy routes (`/plugins/commands` on the
Claude and Pi bridges, `/global/slash-commands` on Codex and Cursor) and the
Claude filesystem scanner behind the first were retired on 2026-10-24, with the
backend's fallback to them. A read without a session makes no request
(`missing`), and an explicit refresh before the session exists reports
`failed` without starting or reading the provider. A bridge older than the
contract (2.21.0) answers the session route with 404; its catalogue is
`unavailable` with `outdated-bridge` until the environment runs a current
bridge, and each such read is counted per agent
(`outdatedBridgeCatalogueReadCounts` in `http-bridge/catalog.ts`, with one
warning per provider instance and no command names). A pre-2.21 bridge that
does answer the session route sends rows without `catalogueVersion`; every
bridge from v2.21.0 on stamps every answer of the route with it, so such an
answer gets the same `outdated-bridge` answer and count, and its rows are never
shown. A catalogue in a version other than 1 (a newer bridge after a
downgrade) is still read as display rows: they get a synthetic `legacy:` ID
(`legacyCommandId`) and run as typed text, never as a selection.
