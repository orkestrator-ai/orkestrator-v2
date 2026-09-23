# 12 — Build provider settings, server editor and operation feedback

Status: planned. Depends on: 02–05 and verified adapter capabilities.
[Plan index](00-index.md).

## Existing and proposed owners

Preserve `apps/web/src/components/settings/McpSettings.tsx` as Control MCP setup.
Add a provider-management section/component under settings, reachable from the
provider settings context and `AgentInfoButton`/`McpServersPanel`. Reuse shadcn/ui
controls and existing backend wrapper conventions.

Suggested components: `ProviderMcpSettings`, `McpTargetPicker`, `McpSourceList`,
`McpServerEditor`, `McpMutationPreview`, and `McpApplyStatus`. Split tests by user
workflow rather than creating one enormous component/test module. The management
service owns operations; React owns only drafts, focus and presentation state.

## Navigation and target selection

Show backend, provider, environment/worktree and scope prominently. Opening from
a live server row carries exact target/source context if known. An unknown-origin
runtime row links to the catalog, not an editable form guessed from its name.

Do not select a shared backend-user scope silently when an environment scope is
unsupported. Present the available scopes and explain impact. Disabled platforms
or missing runtimes can still have editable files if the backend adapter supports
them; “not installed” is distinct from “cannot edit configuration.”

Keep inbound Control MCP setup separate in labels and explanatory text. A user
adding a database MCP to Claude must not be led to rotate Orkestrator's Control
MCP token. Existing Control MCP tests and copy/rotate flows remain intact.

## Catalog layout

Each row shows native name, transport, source/scope, configured enabled state,
effective/shadowed/protected marker, runtime application state and connection
health where known. Group duplicate names by provenance or show their source
inline. Allow disabled and overridden entries to remain discoverable.

An unknown/unsupported definition is visible with a reason and safe available
actions. A malformed source shows its own error, not a “No servers yet” empty
state. Show refresh and a source-location hint without dumping raw config.

Actions are capability-driven. Persistent edit/remove is separate from reconnect
and sign-in. Hide irrelevant actions or disable them with a specific reason;
never assume a server that advertises `disable` supports persisted disable.

## Add and edit workflow

1. Select target/scope and choose Add server. Offer only supported transports.
2. Collect exact name and either executable/argument rows or remote URL. Use
   repeatable key/value controls for env/headers; preserve argument boundaries.
   A command path containing spaces is one executable, not shell syntax.
3. Offer supported provider-specific fields in an advanced section. Show that
   existing advanced fields will be retained if the basic form cannot edit them.
4. Represent saved secrets as “Value saved” with Keep/Replace/Clear controls.
   Do not prefill masked values as text. New project values default to env
   references/private scope. URL/argument values may require retained opaque
   controls too.
5. Validate locally for immediate feedback and authoritatively on the backend.
   Display field-specific syntax errors without launching the server or resolving
   remote endpoints. Back-end errors cannot echo submitted secret values.
6. Request an impact preview, then show destination, changed fields, override
   consequences and application timing. For shared-user scope, identify affected
   environments/known external consumers without promising complete discovery of
   every external process.
7. Offer **Save** and **Save and apply**. Explain that save-only changes future
   provider loads; it does not freeze existing external tools indefinitely.
   Applying a stdio definition may execute its configured program.
8. Submit with request id/expected revision. Keep the draft on validation or
   conflict. On success replace it with authoritative redacted server state.
   Never write success into the inventory optimistically as connected.

When switching provider/target with an unsaved draft, retain it only under its
exact target key or offer discard. A stale async response from the previous
target cannot populate or submit the new target's form. Do not persist drafts
containing secrets to localStorage or generic Zustand persistence.

## Remove, rename and conflicts

Remove confirmation identifies exact source and fallback behavior: “Remove from
this worktree; the user definition will become effective” differs from complete
removal. Include application timing and protected/read-only reasons. Confirmation
does not imply revoking OAuth tokens or deleting plugin packages.

Rename uses the single backend transaction. Keep operation identity stable and
refetch dependent runtime rows when the provider name changes. A collision shows
the conflicting source/name without replacing it automatically.

On revision conflict, keep non-secret draft changes and offer reload/reapply to
the latest source. Do not automatically submit a secret replacement against a
new destination or source. Require a fresh preview when the effective impact
changes. Avoid showing a raw full-file diff that could reveal unrelated secrets.

## Apply progress and recovery

Render operation snapshot states from step 05 with concrete copy:

| State | Example presentation |
| --- | --- |
| Saved, no runtime | Saved; used when this provider next starts |
| Active turn | Saved; applies after current work finishes |
| Pending next turn | Saved; current session will load it on the next turn |
| Applied, connection failed | Saved and loaded; server could not connect |
| Needs auth | Loaded; sign-in required, with only supported auth action |
| Policy blocked | Saved; project servers are excluded for this session |
| Partial outcome | Applied to 2 sessions; 1 waiting, expandable details |
| Reconciliation | Saved state is being checked after a lost connection |

Retry apply references the saved revision. It does not resubmit the config patch.
Keep pending operations visible after switching tabs or navigating away. On mount,
backend change, reconnect and event revision gap, read authoritative snapshots.
Canceling a queued apply clearly leaves saved configuration intact.

Open OAuth URLs through the existing trusted navigation mechanism after user
action. Validate scheme and operation ownership; do not auto-open an arbitrary
URL emitted by a background status update. No UI state may resolve provider
approval/elicitation implicitly.

## Accessibility and verification

- [ ] Labeled inputs, keyboard-only add/edit/remove, predictable dialog focus and
  focus restoration to the initiating row.
- [ ] Status uses text as well as color; progress/errors use appropriate live regions.
- [ ] Long names/paths, many headers and narrow viewport do not overflow controls.
- [ ] Empty/loading/unsupported/offline/malformed/conflict/partial-success states
  have explicit fixture coverage.
- [ ] Target-switch races and duplicate clicks cannot submit to the wrong backend.
- [ ] Secret values are absent from snapshots, DOM after completion, debug output
  and persisted frontend state.
- [ ] Real browser add/edit/remove, reload and inactive-environment paths pass.
- [ ] Existing Control MCP setup and runtime connection controls still work.

Next: [13 — environment delivery](13-environment-delivery.md).
