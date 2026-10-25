# Native-agent slash commands

Status: living. Owner modules:
[`agent-command-catalogue.ts`](../../packages/protocol/src/agent-command-catalogue.ts)
(wire contract, bounds, intent parsing) and
[`agent-slash-commands.ts`](../../packages/protocol/src/agent-slash-commands.ts)
(lexical parsing, resolution, session-action collisions). Outstanding work:
[0016-slash-command-catalogue.md](../todo/cli-and-slash-commands/0016-slash-command-catalogue.md) and
[0015-slash-command-qualification.md](../todo/cli-and-slash-commands/0015-slash-command-qualification.md).

Every enabled row in the native composer's `/` menu must run exactly what it
describes, through a tested executor, and a chosen command must never silently
become an ordinary model prompt.

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
  the route, or it is a pre-2.21 bridge that does not hold the session). The
  backend reports that as `unavailable` with the error code `outdated-bridge`
  and counts it; it never falls back to a global list.
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
name ([public-cli.md](public-cli.md#sessions-and-runs)).

## Session actions and collisions

The backend merges runtime actions into the provider list
(`withSessionActionSlashCommands`):

- `/steer` is **reserved** while steering is qualified: it acts on the live
  turn and never starts a new one. When steering is unavailable a provider's
  own `/steer` is kept, not deleted.
- `/compact` **defers**: a provider that ships its own `/compact` (Claude's
  SDK) keeps it; otherwise the row runs the existing compact session action.

Deduplication is by identity, never by lower-cased display name.

No other shortcuts are planned (decided 2026-10-24 in
[0016](../todo/cli-and-slash-commands/0016-slash-command-catalogue.md#assumptions-and-decisions)).
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
| OpenCode | SDK and server 1.19.0 | 2026-10-17: discovery, `session.command`, refusals, reload |
| Grok | 1.0.52 / ACP SDK 1.8.0 | 2026-10-17: user skills, push updates, re-send after `session/load`; project skills after the folder-trust fix |
| Pi | SDK 1.2.0 | 2026-10-23: discovery, extension-before-template precedence, headless extensions, templates, literal opt-out, mid-turn refresh |
| Cursor | SDK 1.0.37 | 2026-10-17: still `unsupported` |

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
| OpenCode | One `command.list({directory})`; refresh reloads the directory instance when idle | Exact server key, case-sensitive, no aliases | `provider-command` via `session.command` with a reserved `messageID` | List errors fail the read; an empty list stays empty; `stale` while a requested reload waits for idle |
| Pi | One builder over templates, skills and extensions (`sourceInfo` origin) | Template `/name`, skill `/skill:name`, extension invocation name | `provider-prompt` via `session.prompt({source:"rpc"})` | A persisted list is `stale` after restart |
| Grok | ACP `available_commands_update` (push only) | Name as sent; `input.hint` as argument hint | `provider-prompt` via `session/prompt` | `ready` once this process received a list, even an empty one; restored rows are `stale` and not executable |
| Cursor | None | — | — | `unsupported` |
| Orkestrator | Backend | `/steer`, `/compact` | `session-action` | — |

### Unavailable commands

These are listed with a reason and never executed:

| Provider | Commands | Reason |
| --- | --- | --- |
| Claude | `/clear`, `/model`, `/permissions`, `/resume` | `session-changing`: the bridge does not adopt the new conversation ID, and each turn re-applies model and permission mode |
| Claude | Init `terminal_slash_commands` (before a session's first turn, the list the same CLI version reported on an earlier turn), `/login`, `/logout` | `requires-interactive-ui` |
| Claude | `/config`, `/doctor`, `/exit`, `/ide`, `/quit`, `/statusline`, `/terminal-setup`, `/theme`, `/vim` | `unqualified` |
| Codex | Duplicate skill names | `ambiguous` |
| Codex | Disabled skills (`[[skills.config]] enabled = false` in the user `config.toml`; 0.164.0, like 0.162.1, ignores the same entry in a project `.codex/config.toml`, trusted or not) | `disabled` |
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
| OpenCode | `promptAsync` instead of `session.command` | — |
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
  local output, until that first turn.
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
  `commandRevision`; disposal cancels queued settling continuations.
- **OpenCode**: one directory-scoped `command.list`; `session.command` with
  the exact server key. The command response arrives only after the whole
  turn, and every failure maps to HTTP 400, so the provider does not abort it
  on the prompt timeout: acceptance is proven from the reserved `messageID`,
  and a missing answer is ambiguous, never a fallback prompt. OpenCode
  substitutes `$ARGUMENTS` before running a template's `` !`cmd` `` spans
  (observed in the 1.18.31 server, again in 1.19.0). That is OpenCode's own
  template semantics on its own server, so a user's arguments to such a
  command can reach a shell there; Orkestrator adds no shell surface of its
  own. The server reads command files once per directory instance, so a
  refresh disposes that instance (`instance.dispose`) to make it read them
  again. Disposal aborts running work, so it happens only when no session in
  the directory is busy or retrying and no dispatch from this provider is
  open; dispatches wait while it runs. Otherwise the refresh answers
  `deferred`, the catalogue reads `stale`, and the reload is retried at the
  next idle edge on the event stream, after stream reconciliation, and when
  the provider's last synchronous command dispatch ends. A plain
  `promptAsync` acknowledgement is not an idle edge: it can precede the
  server's busy status. Idle edges received during a status check cause
  another whole-directory check. A disposal failure keeps the catalogue
  `stale` and suppresses automatic retries until the next explicit refresh
  (`opencode-command-reload.ts`).
- **Pi**: extensions win over skills and templates, as in the SDK, and only
  the effective winner is listed. Literal intent uses
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
`maxTurns: 0`, so a `prompt: ""` probe used to start a real turn.

There is no global catalogue. The legacy routes (`/plugins/commands` on the
Claude and Pi bridges, `/global/slash-commands` on Codex and Cursor) and the
Claude filesystem scanner behind the first were retired on 2026-10-24, with the
backend's fallback to them. A read without a session makes no request
(`missing`), and an explicit refresh before the session exists reports
`failed` without starting or reading the provider. A bridge older than the
contract (2.21.0) answers the session route with 404; its catalogue is
`unavailable` with `outdated-bridge` until the environment runs a current
bridge, and each such read is counted per agent
(`outdatedBridgeCatalogueReadCounts` in `http-bridge-catalog.ts`, with one
warning per provider instance and no command names). A pre-2.21 bridge that
does answer the session route sends rows without `catalogueVersion`; those are
non-enhanced: they get a synthetic `legacy:` ID (`legacyCommandId`) and run as
typed text, never as a selection.
