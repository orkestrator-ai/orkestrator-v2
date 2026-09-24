# 01 — Establish compatibility evidence and resolve adapter decisions

Status: planned. Dependencies: none. [Plan index](00-index.md).

## Purpose

Replace plausible API assumptions with evidence for the exact checked-in provider
versions. This step produces a capability matrix and fixtures used by subsequent
steps; it does not build an editor or change user configuration.

Existing owner references are linked in the [investigation](../../mcp.md).
Use temporary homes, fixture worktrees, deterministic local MCP endpoints, and
the repository's isolated test profile when a complete stack is required.

## Work items

1. Record SDK/CLI versions, operating system, launch settings, project trust and
   config roots for each probe. Read the pinned SDK declarations/generated
   protocol, then consult current official docs. Do not infer installed-version
   support from a latest-documentation snippet.
2. Construct one stdio fixture and one HTTP fixture exposing a uniquely named,
   harmless tool. Add a failure fixture and an auth-required fixture. All use
   synthetic values. Capture only method names, bounded status, revisions and
   fixture identifiers; no real credentials or user prompts.
3. For each provider, create server A, change its tool identity/configuration,
   rename it, remove it, then create a new session and restart the owning process.
   Verify both the source file and actual available tools at each boundary.
   “Status row disappeared” alone is insufficient proof of removal.
4. Repeat with two same-name entries in different scopes. Record the effective
   source, merge granularity, fallback after removal, and whether disabling the
   higher layer masks or reveals the lower layer.
5. Repeat with two sessions, one active and one idle. Identify whether application
   affects a thread, session, directory, process, or all runtimes sharing a user
   source. Record any restart or transcript-identity consequences.

## Provider questions that must be answered

| Provider | Required probe | Decision it controls |
| --- | --- | --- |
| Claude | Compare current manual merge with native local/project/user precedence | Preserve behavior explicitly or make a separately reviewed correction |
| Claude | Confirm `setMcpServers` shape/results, plugin retention, injected-name preservation and draining-query errors | Whether optional runtime replacement is safe; default remains next query |
| Claude | Trace actual config paths when `CLAUDE_CONFIG_DIR` is set | Authoritative target resolver and writer path |
| Codex | Write with `expectedVersion`, provoke conflict, remove a server table and preserve comments | RPC versus safe-file persistence and delete semantics |
| Codex | Reload with multiple loaded/detached threads and launch overrides | Applied-revision rules and process-wide impact text |
| OpenCode | `mcp.add`, config update, disconnect and deletion across restart | Separate runtime mutation from persistence; select a safe reload mechanism |
| OpenCode | Observe config update/dispose effects on other directory sessions | Reconciliation scope and shared-process busy gate |
| Cursor | Use per-send server replacement on `1.0.31`; remove an inherited file entry; resume vendor identity | Next-send versus idle reattach; prevent fallback resurrection |
| Cursor | Verify user/project/plugin precedence and local OAuth limits | Editable sources and honest authentication capability |
| Grok | Native config versus compatibility sources, ACP supplied entries and supported transports | Provenance, codec and wire compatibility |
| Grok | Change source then load/resume existing conversation | Whether next load applies edits without transcript loss |
| Pi | Rebuild inline MCP extension after config change without losing session file | Tool registry generation and detach/reattach contract |
| Pi | Distinct names normalizing to one id; SSE-declared configuration | Reject ambiguity and avoid false transport support |

For OpenCode, explicitly distinguish the SDK's `/v2/client` import from proposed
future server/session v2 endpoints. For Codex, use methods in the committed
generated `ClientRequest` rather than replacing them with newer upstream names.

## Target and product decisions

Produce a table for every source with: display label, scope, real owner,
configuration path rule, file format, MCP subtree, precedence, trust gate,
write support, native/terminal consumers, and copy/materialization behavior.
Include custom home variables, XDG paths and remote-backend paths. These are
resolved on the backend, never on the browser machine.

Specify each capability separately: passive catalog, add/edit/remove/rename,
persistent enable, live reconnect, authentication, transport, and safe apply
strategy. Lack of hot reload must not disable persistent editing. Lack of a
reliable writer must disable writes rather than inventing a partially working
operation.

Record the initial behavior of malformed and oversized files. A discovery parser
that currently returns `[]` on error must not become a writer that overwrites the
file as empty. Record plugin and managed-policy entries as separate ownership
classes, even where the existing runtime model has no corresponding scope.

## Deliverables

- A versioned adapter capability table, committed with the implementation work.
- Minimal synthetic native config fixtures, including comments, advanced fields,
  duplicate names across scopes, disabled entries and protected-name collisions.
- A probe-results document with exact commands, expected/actual results and
  skipped cases. Mark any unverified behavior as unavailable or pending.
- A decision for every table row above, with the adapter tests it requires.

## Acceptance criteria

- [ ] Every proposed method exists on the pinned integration or is explicitly
  behind a capability gate with a documented fallback.
- [ ] Each provider has a proven persistence path and a safe application boundary.
- [ ] Tests never read/write the operator's real config or launch repository
  project MCP servers as a side effect of discovery.
- [ ] Existing behavior discrepancies are recorded; no silent precedence change
  is hidden inside the editor feature.
- [ ] The remaining plan is updated if a probe invalidates an assumed strategy.

Exit: proceed to [02 — contracts](02-contracts-and-validation.md).
