# Platform version audit — 2026-09-22

Status: Historical snapshot of the 2026-09-22 platform refresh.

## Updated versions

| Platform | Previous | Current | Result |
| --- | --- | --- | --- |
| Claude | Agent SDK `0.3.276`, Anthropic SDK `0.126.0`, CLI `2.1.276` | Agent SDK `0.3.280`, Anthropic SDK `0.128.0`, CLI `2.1.280` | Updated; usage accounting fixed |
| Codex | CLI/protocol `0.155.0` | CLI/protocol `0.155.1` | Updated; generated protocol byte-identical |
| OpenCode | SDK/CLI `1.18.31` | SDK/CLI `1.18.32` | Updated; SSE patch rebased (hunks unchanged) |
| Grok | CLI `1.0.34` | CLI `1.0.41` | Updated; argv and `initialize` unchanged |
| Cursor | SDK `1.0.31` | SDK `1.0.32` | Updated; diagnostic seam patch re-identified |
| Pi | SDK/CLI `0.85.1` | SDK/CLI `0.87.0` | Updated; two compile breaks fixed |
| ACP | SDK `1.4.0` | SDK `1.5.0` | Updated; `notice` updates supported |

Every changed desktop binary has fresh size and SHA-256 records for macOS and
Linux on arm64 and x64, verified against fresh upstream downloads with
`verify-toolchain-artifacts.ts`. The Dockerfile's independent Linux digests for
OpenCode, Grok and Pi were updated from the same records.

## Breaking changes handled

- **Claude cost and token totals are cumulative across a resume (CLI
  2.1.277+).** A resumed `query()` now continues the running totals its
  transcript saved, so the first result already carries earlier turns. The
  bridge runs one resumed `query()` per turn and added each result onto the
  previous snapshot, which double-counted every earlier turn. The bridge now
  turns each result into a per-turn delta against the last running totals
  (`claudeTurnUsageDelta` in `session-manager-core.ts`), resetting that
  baseline per query only for a CLI older than 2.1.277. The same change fixes a
  pre-existing double count when one query yields two results, as a
  background-task continuation does. A count that goes down (`/clear`, or a
  transcript with no saved totals) is read as the turn's own; an all-zero
  result is ignored.
- **Pi session entries `usage` and `context_edit`.** New `SessionEntry` kinds
  fell through to `entry.message` during history hydration — a typecheck error
  and a runtime throw. Both are skipped: usage is already counted by
  `getSessionStats`, and a context edit changes what the model sees, not the
  conversation Pi's own UI shows.
- **Pi steer now awaits extension input handlers before queueing.** A run that
  settled in that gap left the steer in Pi's queue after `settleTurn` cleared
  it, so a later prompt consumed it. The bridge re-checks the run after
  `steer()` resolves and withdraws a late steer.
- **Cursor `tool-requests-listed` update.** A step-level count ahead of the
  tool calls, which already render. Accepted as a known no-op alongside
  `step-started`/`step-completed` rather than counted as drift.

## New functionality, normalized

- **ACP `notice` session updates** (ACP 1.5,
  `ClientSessionCapabilities.notices`). The bridge advertises the capability and
  maps each notice onto the shared `RuntimeHealthRecorder` as a provider notice,
  so it appears in the same runtime-health panel as every other bridge's
  notices, and error notices surface as transcript advisories. Grok 1.0.41 does
  not emit them yet.
- **Claude slash-command sources.** `SlashCommand.builtin` (SDK 0.3.280) now
  drives the shared `source` field. Previously every Claude command was labelled
  built-in; user, project and plugin commands now group correctly, and a
  built-in row wins a name collision as the SDK documents.
- **Claude Opus 5.5 and Fable 5.1 defaults.** CLI 2.1.280 resolves `default`
  and `opus[1m]` to `claude-opus-5-5[1m]` and Fable to `claude-fable-5-1`. The
  fallback catalogues used when `supportedModels()` fails were updated, the web
  copies collapsed onto one shared table, and legacy tmux aliases map saved ids
  forward only when the running CLI no longer lists them.
- **Pi per-model image limits.** Pi 0.87 resizes `prompt()` images per model
  but not steer or follow-up images; the bridge now applies the model's resize
  profile on those two paths.

## Reviewed and deliberately not adopted

- Claude MCP Apps widgets (`readMcpResource`, `_meta.ui`): Codex has the same
  concept; it needs a provider-neutral tool-card field before either bridge
  wires it.
- Claude `verbatimPrompts` / `client_composed`: skips the CLI's turn-start
  attachment pass, which is a real behaviour cost with no reported problem to
  solve.
- Pi `meta` provider hosts: outside the Pi allowlist's mainstream-provider
  policy; users can add `api.meta.ai` through `allowedDomains`.
- Pi prompt cache warming: live by default in streaming mode and already
  attributed to the running turn's cost; the shared layer has no setting for it.
- OpenCode 1.18.32: the SDK is byte-identical apart from its version.

## Known gaps

- Pi steer delivery still matches on exact text, so an extension `input`
  handler that rewrites a steer leaves it pending until the turn settles.
- Pi `followUp` has the same post-settle queueing race the steer fix closes.
