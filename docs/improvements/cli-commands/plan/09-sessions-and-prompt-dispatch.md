# 09 — Launch sessions and dispatch prompt intent

Status: Verified — see record.
Index: [CLI commands plan](00-cli-commands-index.md).

## Target behavior

`session start` launches an independent native conversation, `session prompt`
continues one explicit conversation, and `environment launch` creates/starts a
workspace with a persisted first prompt. All return recoverable submission
receipts and work without a mounted UI. Completion is qualified in step 10.

## Owners and starting points

- [Control job commands](../../../../apps/backend/src/core/commands-registry-control.ts).
- [Control MCP launch/prompt actions](../../../../apps/backend/src/core/control-mcp-server.ts).
- [Native dispatch commands](../../../../apps/backend/src/core/commands-registry-native.ts)
  and [dispatch service](../../../../apps/backend/src/core/native-agent-service-dispatch.ts).
- [Startup reconciliation](../../../../apps/backend/src/core/native-agent-service-reconciliation.ts).
- [Native job tab storage tests](../../../../apps/backend/src/core/storage-native-agent-job-tabs.test.ts).

## Work

1. Implement `session start --environment ID --agent …` using the durable
   control-job path. Validate enabled provider, live model/reasoning capabilities,
   resolved defaults, running/setup-ready state, and pending deletion. Persist
   exact selected values and stable tab/session/run identities before dispatch.
2. Move remaining reusable launch validation/orchestration from Control MCP
   into the shared backend action owner introduced in step 04. Keep its
   coordinator scope, delegation presentation, and role-specific fields trusted;
   a CLI request cannot self-assert them.
3. Implement follow-up by public session ID and resolve the current provider
   identity in the backend. Never choose the active UI tab or create a new
   conversation implicitly if the requested session has disappeared.
4. Add bounded UTF-8 prompt-file/stdin inputs. Enforce mutually exclusive sources,
   empty/oversized input checks, and content-preservation rules before admission.
   Client files are read locally; backend workspace paths are not substitutes
   for file transfer. Leave attachments unadvertised in this milestone.
5. Carry request IDs through the public operation and existing native dispatch
   journal. Preserve accepted/rejected/unknown and provider-versus-transport
   uncertainty; do not acknowledge completion. Persist recovery references and
   expose them in the receipt even if the HTTP acknowledgement is lost.
6. Implement `environment launch` as a backend-owned composition of create,
   start/setup, and persisted startup intent. Link the public operation to the
   existing stable `startup-agent` session and initial-prompt dispatch key.
   Do not also call `session start` from the CLI after creating pending intent;
   that would dispatch two initial prompts.
7. Report partial launch with environment/session IDs and stage/error. On setup
   failure, keep the prompt undispatched and recovery explicit. A retry reuses
   the same operation; no browser acknowledgement or mounted effect completes
   the flow. Keep a first prompt's model/mode settings stable across restart.
8. Reject ordinary follow-up while busy by default. Explicit enqueue support
   may wrap the existing durable queue after capability/ordering qualification;
   steering stays a separate action in step 11. Plain prompt text, queue intent,
   and selected slash commands retain their type through journal/recovery.
9. Preserve user UI selection: background session launch can create a discoverable
   tab without focusing it. A late provider/session update must not reactivate
   the tab after the user switches environments or closes it.

## Verification

Cover new and existing sessions for every provider adapter using controlled
boundaries: valid defaults, unsupported model/reasoning, setup incomplete,
pending deletion, missing target, concurrent launch, unknown dispatch, and
same-key changed prompt. Test multiline/non-ASCII/stdin/oversized input and
verify routine logs contain no prompt sentinel.

Run a renderer-free startup test that progresses from persisted pending intent
to exactly one initial provider submission. Drop the client connection and
restart at stage boundaries. Verify one tab/session and no second initial turn.
Qualify actual provider submission in step 14's opt-in matrix.

## Acceptance and handoff

- [x] New-session and continuation intent target distinct explicit actions.
- [x] Backend state owns launch and first-prompt progression.
- [x] Every possibly submitted prompt retains request/run recovery identity.
- [x] Busy, unsupported, and unknown cases do not silently change intent.
- [x] CLI and MCP reuse launch behavior without broadening authority.

Expose submission-only semantics until step 10 qualifies waiting. Disabling
new launches must not stop reconciliation of accepted startup or prompt intent.

## Implementation record

Revision: working tree on `a9337716`, 2026-09-26.

- `session start` uses `launch_native_agent_job` (backend-owned tab,
  exactly-once first prompt, `activateTab: false`); `session prompt` uses
  `dispatch_native_agent_intent` with busy/parked checks and mode
  preservation ([`actions-sessions.ts`](../../../../apps/backend/src/core/public-api/actions-sessions.ts)).
  `environment launch` composes create/start/first prompt with one receipt.
- Tests: `public-api-sessions.test.ts` (replayed start sends once, not-ready
  refused, busy never queued/steered, parked dispatch), `public-api-launch.test.ts`;
  live runs for Claude, Codex, OpenCode (step 14).
