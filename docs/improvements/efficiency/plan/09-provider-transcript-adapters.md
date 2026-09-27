# 09 — Implement lightweight transcript and detail reads for every provider

Status: Not started. Prerequisites: 02, 05, 08. Finding: E06.

## Outcome

Large artifacts do not enter the bridge live window merely to be removed later
by the backend. Each provider advertises only features it actually implements.
Native chat can use summaries without breaking old clients or exact consumers.

## Provider work map

| Provider | Main owners | Particular constraint |
| --- | --- | --- |
| Claude | `routes/session.ts`, `services/session-manager-*` | Revision from step 05; hydration and local overlays |
| Codex | `index.ts`, `app-server-runtime-sessions.ts`, `messages/` | Never await from stdout; attached vs cached preview |
| Cursor | `http.ts`, `translate.ts`, `transcript.ts`, `state.ts` | Producer bounds and stable identity after trim |
| Pi | `http.ts`, `translate.ts`, `transcript.ts`, `state.ts` | SDK events synchronous; durable Pi history remains authoritative |
| Grok/ACP | `acp-http.ts`, `acp-transcript.ts`, `acp-public.ts` | Truncation notices and replayed updates |
| OpenCode | Backend `opencode-snapshots.ts`, `opencode-stream-state.ts` | In-process adapter; incremental SSE cache and SDK v2 |

Paths for bridge rows are under `bridges/<provider>-bridge/src/`; backend rows
are under `apps/backend/src/core/`. New small adapter modules should keep
normalization out of route/composition-root files.

## Shared implementation

1. Build summaries from the normalized message boundary, before response
   windowing. Reuse completed summary parts by trustworthy mutation revision.
   Keep current raw provider state for its existing duties; do not eagerly
   duplicate every payload into a second artifact store.
2. Prefer a locator into already owned exact data. If the only representation
   is a mutable transient value, freeze/version that specific detail at a
   bounded handoff point. Historical locators must not resolve to the latest
   mutated value. Cap retained detail revisions and return expired explicitly.
3. Issue detail locators with source message/part identity and content revision.
   Backend/frontend requests carry identity and authorization context; a client
   cannot replace the locator with an arbitrary provider file path or URL.
4. Perform per-message/part summary sizing through step 02, then apply the live
   window. A multi-megabyte screenshot must leave a small attachment summary
   rather than displacing every earlier message.
5. Make unchanged reads depend on the summary revision, metadata, and window
   parameters, without serializing raw details. Detail changes that alter a
   summary's locator/preview invalidate that part's revision.
6. Serve details under independent response and in-flight byte limits. A slow
   artifact consumer cannot hold a provider stdout callback or block unrelated
   summary reads. Catch cancellation errors; share reads only with correct
   ownership/ref-counting and per-session scope.
7. Extend `HttpBridgeProvider` and the in-process OpenCode adapter to expose
   the new surface. Keep backend detail normalization compatible with existing
   `get_native_agent_tool_details` callers, translating locators internally.
8. Update projection hydration decisions: use summary completeness/pageability,
   not raw artifact size, to decide if a broader read is necessary. Retain a
   bounded legacy fallback for unsupported bridges, recording its use.

## Provider-specific checks

- Claude: overlays, background task decoration, SDK history load, and title-only
  changes all participate in summary revision. Do not spawn catalogue probes
  to answer transcript or detail reads.
- Codex: freeze detail revisions off the stdout path; avoid keeping entire render
  state alive through one detail reference. Detached previews remain cached and
  incomplete until their source history is actually hydrated.
- Cursor/Pi/ACP: audit new-part initialization as well as append paths. IDs must
  not be derived solely from the current length after front trimming. Preserve
  active lifecycle registries when summary rows are evicted.
- OpenCode: retain `/v2/client` imports and current SSE rejection handling. A
  cached source revision may skip normalization; do not re-fetch SDK history
  simply to mint a detail reference.

Before invoking new vendor SDK/CLI capabilities, resolve current documentation
through Context7 as required by AGENTS.md. No upgrade is assumed by this plan;
use the existing pinned API or preserve a documented capability fallback.

## Tests and rollout

Run the shared contract fixture through every adapter: large result, diff,
image, nested tools, missing detail, streaming mutation, trim, restart, rewind,
and generation replacement. Compare visible summaries with legacy behavior and
exact details with the source revision. Test old clients against new bridges and
new backend against an old bridge returning v1.

Ship one provider family at a time behind actual capability advertisement;
enable backend preference only when that adapter's tests pass. Measure raw bridge
bytes and incomplete-hydration calls before/after. E06 is complete only when all
six providers have the new behavior or an explicit bounded fallback documented
with its remaining cost.
