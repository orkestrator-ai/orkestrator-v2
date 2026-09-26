# 04 — Share backend actions and expose read-only discovery

Status: Verified — see record.
Index: [CLI commands plan](00-cli-commands-index.md).

## Target behavior

CLI discovery returns bounded, authoritative project, environment, session,
and provider summaries. Shared validation and resource resolution live behind
the command registry, so later mutations and Control MCP do not diverge.

## Owners and starting points

- [Registry](../../../../apps/backend/src/core/commands-registry.ts) and
  [command context](../../../../apps/backend/src/core/commands-context.ts).
- [Control MCP](../../../../apps/backend/src/core/control-mcp-server.ts):
  launch options, public summaries, native-tab resolution, scope enforcement.
- [Project](../../../../apps/backend/src/core/commands-registry-projects.ts),
  [environment](../../../../apps/backend/src/core/commands-registry-environments.ts),
  and [native](../../../../apps/backend/src/core/commands-registry-native.ts) commands.
- [Storage sessions](../../../../apps/backend/src/core/storage-sessions.ts).

## Work

1. Add the step-01 public capabilities and read actions through the existing
   registry. Implement `project list/get`, `environment list/get`, `session
   list/get`, and `agent options`, then expose their CLI adapters.
2. Extract reusable public-summary mapping, launch-option discovery, and native
   tab resolution from Control MCP into focused backend modules. Keep MCP result
   formatting and tool annotations in the MCP adapter. Move mutation orchestration
   only as needed by steps 06–11 rather than rewriting the entire MCP server.
3. Define a stable public session handle mapped to environment, tab, provider,
   and logical-session identity. Resolve it in the backend and scope every lookup.
   Persist the mapping if it cannot be derived durably from existing records.
   Do not change handles merely because a bridge resumes with a new provider ID.
4. Enforce ownership at the backend action boundary, not just parser validation.
   MCP coordinator calls still use their project scope and trusted delegation
   context. Ordinary operator arguments cannot manufacture that context.
5. Build allowlisted summary fields with effective agent settings, environment
   setup/activity, lifecycle errors, safe session state, and interaction counts.
   Do not expose raw `get_environment`, config, or native-session storage records.
6. Use authoritative resource snapshots for routine lists. Keep explicit refresh
   separate from cheap observation: `get_environments` also reconciles status,
   while snapshot commands are cheaper. Declare freshness and unavailable state
   so a stale projection cannot be interpreted as proof of completion.
7. Implement bounded pagination and stable ordering. Define cursor behavior if
   the collection generation changes, and reject ambiguous names. Large lists
   must not load transcripts or construct unbounded public responses.
8. Expose catalogue provenance and freshness with supported model/control options.
   A successful empty catalogue differs from unavailable/stale data. Model
   discovery can have startup cost; keep it explicit and bounded, never on every
   ordinary session poll. Preserve existing inherited-settings precedence.
9. Add an action registration/capability consistency check: advertised actions
   have handlers and supported schemas. Keep raw registry dispatch outside the
   stable user command surface.

## Verification

Compare CLI and MCP summaries for the same stored fixtures. Test duplicate
names, multiple tabs/providers, missing layout entries, resumed provider IDs,
deleted resources, pagination expiry, and catalogues that are empty or unavailable.
Verify coordinator scope still excludes foreign resources and forged delegation
fields. Assert list/get does not invoke attachment or transcript hydration.

Use real storage for stable identity across a fresh backend object. Include one
real gateway → registry → storage read scenario in step 14's initial harness.

## Acceptance and handoff

- [x] CLI read commands work with no renderer and stable explicit IDs.
- [x] Shared resolution/validation has one owner for CLI and MCP consumers.
- [x] Public summaries and pages enforce content and size boundaries.
- [x] Cheap observation does not revive idle sessions or hide stale state.
- [x] Existing MCP tools retain their outputs and authority restrictions.

Keep the extraction behavior-preserving for existing consumers. New read
capabilities can be disabled independently if qualification finds an issue.

## Implementation record

Revision: working tree on `a9337716`, 2026-09-26.

- Shared helpers extracted to
  [`control-shared-actions.ts`](../../../../apps/backend/src/core/control-shared-actions.ts)
  and used by both the control MCP server and `public-api/actions-discovery.ts`;
  MCP formatting, annotations and coordinator scope unchanged (existing MCP
  tests pass in `mise run test`).
- Reads never hydrate transcripts or attach providers
  (`public-api-sessions.test.ts`: list/get/run reads, coalesced status reads).
  `agent options --refresh` asks providers explicitly; a failed refresh with
  known models reports `stale`.
