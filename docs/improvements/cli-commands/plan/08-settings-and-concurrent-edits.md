# 08 — Edit project and environment settings safely

Status: Verified — see record.
Index: [CLI commands plan](00-cli-commands-index.md).

## Target behavior

`project config` and `environment config` expose typed, partial edits with
explicit unset/inheritance and application timing. Concurrent CLI/UI writers
cannot silently replace one another's configuration or launch intent.

## Owners and starting points

- [Repository config commands](../../../../apps/backend/src/core/commands-registry-projects.ts).
- [Environment setting commands](../../../../apps/backend/src/core/commands-registry-environments.ts).
- [Configuration storage](../../../../apps/backend/src/core/storage-config.ts)
  and [environment storage](../../../../apps/backend/src/core/storage-projects.ts).
- [Shared agent settings](../../../../packages/protocol/src/agent-settings.ts).
- [Native control updates](../../../../apps/backend/src/core/commands-registry-native.ts).

## Work

1. Inventory exposed fields and publish a schema matrix: type, owning record,
   inherited source, supported environment types, validation, default/unset,
   and application timing. Start with existing repository settings and supported
   environment ports, domains, and agent defaults; exclude credentials.
2. Implement `config get`, `set`, and `unset`, including a bounded JSON patch
   file input. Reject unknown fields, malformed tiers, invalid ports/domains,
   conflicting flags, and ambiguous null versus omission. Distinguish raw
   overrides from resolved effective values and their source tier.
3. Apply patches atomically in backend storage. Do not call `save_config` with
   a whole document assembled by the CLI. Multi-field edits validate before
   publication; unsupported mixed-record atomic updates must fail rather than
   partially succeed under one misleading result.
4. Add expected-revision checks to each supported resource/config scope. Legacy
   UI mutations must advance the same revisions. A generation reset conflicts
   with an old revision; a refresh can show the new state but must not silently
   retry a stale write. Reuse existing revision primitives where their scope
   matches instead of inventing a parallel revision scheme.
5. Preserve launch-intent fields when editing ordinary environment defaults.
   An agent-settings omission does not clear the tier; explicit unset restores
   inheritance. Do not erase initial prompts, attachments, or pending launch
   selection as a side effect of config serialization.
6. Report `applied`, `next-session`, or `restart-required` per changed setting.
   Saving environment defaults does not reconfigure an already-running provider
   conversation. Direct live-session controls belong to step 11. Do not claim
   a running container adopted new ports/network rules from a stored edit alone.
7. Emit existing config/resource change notifications and verify fresh snapshots
   rehydrate when the UI becomes active again. Reuse backend reconciliation for
   settings such as PR baseline that have existing immediate effects.
8. Define behavior during start/delete/recreate. Serialize or reject edits whose
   application would race a lifecycle capture; persist the exact settings used
   by an admitted launch so operation replay remains stable.

## Verification

Test two independent writers changing the same and different fields, UI writes
between CLI read/write, stale generations, explicit unset, malformed patches,
partial validation failure, and edits during startup. Assert pending launch
intent remains unchanged unless directly targeted. Cover global → repository →
environment precedence using the shared resolver.

Use a focused UI/CLI scenario: save from CLI while an environment is inactive,
return/reload, and verify stored/effective values and next-start indicators.
No test should pass merely because the write response echoed the requested value.

## Acceptance and handoff

- [x] Public setting fields have typed validation and explicit unset behavior.
- [x] Updates are atomic at their documented scope and revision conflicts are enforced.
- [x] Concurrent callers preserve unrelated state and all launch-intent fields.
- [x] Responses distinguish storage changes from live application.
- [x] UI rehydration reads the same authoritative effective configuration.

Keep new revision fields backward-readable. Reverting CLI config support must
not restore a stale whole-config write path or discard saved overrides.

## Implementation record

Revision: working tree on `a9337716`, 2026-09-26.

- Typed descriptors (`PUBLIC_PROJECT_SETTINGS`, `PUBLIC_ENVIRONMENT_SETTINGS`),
  patch-only updates with content-hash revisions checked under the owning
  lock ([`actions-settings.ts`](../../../../apps/backend/src/core/public-api/actions-settings.ts),
  `updateProjectAtRevision`/`patch*AtRevision`). `null` is not unset;
  `--unset` is explicit. Each value reports `application`
  (`applied`/`next-start`/`next-environment`).
- `updateEnvironment` no longer drops `initialConversationMode`.
- Tests: `public-api-projects.test.ts` (partial edits, stale revision,
  unknown keys, launch intent preserved); `local-lifecycle` scenario stale
  revision. UI rehydration: `cli-ui.spec.ts` (value in the open dialog and
  after reload).
