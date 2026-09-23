# Native-agent slash commands

Status: living. Owner modules:
[`agent-command-catalogue.ts`](../../packages/protocol/src/agent-command-catalogue.ts)
(wire contract, bounds, intent parsing) and
[`agent-slash-commands.ts`](../../packages/protocol/src/agent-slash-commands.ts)
(lexical parsing, resolution, session-action collisions). Background and
findings: [investigation](../improvements/slash-commands.md) and
[implementation plan](../improvements/slash-commands/plan/00-index.md).

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
  `missing`; a 404 means the route predates this contract. The backend never
  falls back from a `missing` session to a global list.
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

## Session actions and collisions

The backend merges runtime actions into the provider list
(`withSessionActionSlashCommands`):

- `/steer` is **reserved** while steering is qualified: it acts on the live
  turn and never starts a new one. When steering is unavailable a provider's
  own `/steer` is kept, not deleted.
- `/compact` **defers**: a provider that ships its own `/compact` (Claude's
  SDK) keeps it; otherwise the row runs the existing compact session action.

Deduplication is by identity, never by lower-cased display name.

## Provider notes

Qualification evidence and the full support table are in the
[qualification record](../improvements/slash-commands/qualification.md).

- **Claude**: rows are the SDK's own names; `/skill:` is never synthesized.
  Session-changing (`/clear`, `/model`, `/permissions`, `/resume`),
  terminal-only and unqualified commands are listed unavailable, and the bridge
  also refuses them as typed text. Local command output is persisted as a
  transcript row.
- **Codex**: skills run as structured `skill` input (`$name`, alias
  `/skill:name`); templates are an Orkestrator compatibility feature with
  bounded discovery and `$ARGUMENTS` only. Inline `` !`…` `` shell spans are
  disabled. `/help` and `/models` are bridge-local; reserved names cannot be
  shadowed by a template.
- **OpenCode**: one directory-scoped `command.list`; `session.command` with
  the exact server key. The command response arrives after the whole turn, so
  acceptance is proven from the reserved `messageID`.
- **Pi**: extensions win over skills and templates, as in the SDK. Literal
  intent uses `expandPromptTemplates: false`, which cannot stop extension
  `input` handlers. Refresh is deferred while a turn runs.
- **Grok**: push-only inventory; a list restored from disk is `stale` and not
  executable until Grok reports it again.
- **Cursor**: `unsupported`; application actions such as `/steer` remain.

## Lifecycle

The backend caches one catalogue per environment, provider, runtime
generation and session, with status `loading`, `ready`, `stale`,
`unavailable` or `unsupported` projected as `slashCommandCatalogue` next to
`slashCommands`. Failures keep the previous list as `stale` with a bounded
error code and retry backoff; they never become `ready: []`. Selected
commands are revalidated at dispatch, dequeue and retry.
