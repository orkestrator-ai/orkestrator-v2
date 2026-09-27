# 07 — Restore drafts using the shared attachment capabilities

Status: Implemented (2026-09-26); verified live for Cursor and the pre-session picker; the assigned Grok tab UI is not yet observed live (the Grok CLI did not connect). Not merged. See [step 11 evidence](11-conformance-verification-and-release-handoff.md#evidence-record-2026-09-26).  
Depends on: [01](01-contract-baseline-and-regression-fixtures.md).  
Finding: INC-06.

## Target behavior

A structurally valid image draft for Cursor or Grok survives a fresh renderer
load and the subsequent autosave. All native platforms derive attachment-type
eligibility from the shared capability table. Draft restoration remains
separate from model-specific send validation and does not discard data merely
because a live model catalog is temporarily unavailable.

## Owners

- [Draft persistence hook](../../../../apps/web/src/hooks/useNativeComposeDraftPersistence.ts).
- [Shared capabilities](../../../../packages/protocol/src/native-agent.ts).
- [Existing attachment helpers](../../../../apps/web/src/lib/chat/workspace-attachments.ts).
- [Assigned composer controller](../../../../apps/web/src/components/native-agent/AgentNativeTab.controller.tsx)
  and [unassigned composer](../../../../apps/web/src/components/native-agent/AgentNativeTab.helpers.tsx).
- [Existing draft tests](../../../../apps/web/src/lib/draft-persistence.test.ts)
  and [attachment tests](../../../../apps/web/src/lib/chat/workspace-attachments.test.ts).

## Implementation tasks

- [x] Split structural validation from platform eligibility. Validate `id`,
  `name`, `path`, attachment type, and existing optional fields before consulting
  capabilities. Do not loosen malformed-record handling to preserve images.
- [x] Resolve an assigned namespace through the shared `isAgentPlatform` guard
  and `nativeAgentCapabilities(platform).attachments` rather than another copied
  list of native platforms.
- [x] For `agent-native`, read the saved platform metadata using the same guard.
  A known saved platform must have the same eligibility as an assigned tab.
- [x] Preserve explicit legacy `claude-tmux` handling outside the native table.
  Do not pretend terminal delivery accepts the same payload as a native bridge.
- [x] Define the unassigned/unknown-metadata fallback deliberately. Preserve
  structurally valid undecided draft content until a valid platform is chosen,
  then apply the existing selection reconciliation; do not erase an undecided
  draft simply because no provider capability is yet available.
- [x] Reuse `retainSupportedAttachments` if its imports are suitable for the
  persistence layer. If importing it pulls UI components into a pure validator,
  extract only the small pure type-eligibility helper to an appropriate shared
  frontend module; do not introduce a cyclic dependency.
- [x] Keep model vision support in send/selection validation. Restoring a draft
  should not destroy an image while the catalog is loading or a model change is
  pending. Existing user-visible incompatibility handling remains in the composer.
- [x] Preserve attachment IDs, paths, preview metadata, annotation references,
  and order. Do not rewrite files, copy image bytes, or persist browser object
  URLs as a new storage format in this fix.
- [x] Verify hydration's autosave preserves the recovered images rather than
  immediately publishing a filtered empty list. Assert the backend write payload,
  not only in-memory hook state.
- [x] Keep revision-conflict behavior and the “do not overwrite typing while
  loading” guard unchanged. Test attachment-only drafts and fallback-namespace
  migration under those races.

## Capability matrix

At the review revision, expected type eligibility is:

| Namespace/platform | File draft | Image draft | Source of policy |
| --- | --- | --- | --- |
| Claude native | Preserve | Preserve | Shared native capability table |
| Codex native | Reject unsupported file | Preserve | Shared native capability table |
| Cursor native | Reject unsupported file | Preserve | Shared native capability table |
| Grok native | Reject unsupported file | Preserve | Shared native capability table |
| OpenCode native | Preserve | Preserve | Shared native capability table |
| Pi native | Preserve | Preserve | Shared native capability table |
| `agent-native` with known platform | Match selected platform | Match selected platform | Saved metadata plus shared table |
| Undecided/unknown platform | Preserve structurally valid draft provisionally | Preserve structurally valid draft provisionally | Explicit undecided-draft rule |
| `claude-tmux` | Keep existing documented legacy behavior | Keep existing documented legacy behavior | Terminal attachment contract |

Generate native-platform tests from the actual capability function and also
retain explicit Cursor/Grok regressions. A test that duplicates a static second
table would reproduce the drift this change is meant to eliminate.

## Regression cases

Proposed file: `apps/web/src/lib/native-draft-attachments.test.tsx`, or a focused
split of existing draft tests if that better matches the harness.

Implemented as (2026-09-26): `apps/web/src/lib/native-draft-attachments.test.tsx` and the browser spec `e2e/agent-testing/native-draft-attachments.spec.ts`.

1. Restore one valid image for assigned Cursor and Grok tabs; verify the next
   persisted revision contains the same image and preserves its metadata.
2. Repeat with `agent-native` metadata selecting each platform and with a fallback
   record adopted by an assigned tab.
3. Mix supported images, unsupported files, and malformed entries. Keep only
   the structurally valid eligible entries in original order.
4. Restore an attachment-only draft; it must not be treated as empty and deleted.
5. Type/add an attachment while hydration waits; late hydration must not replace
   the local draft with the older saved value.
6. Resolve a save conflict after hydration; preserve the established revision
   safeguards and explicit user choice.
7. Change platform after restore. Apply the existing capability reconciliation
   exactly once and avoid redundant writes or an effect loop.
8. Exercise missing/invalid platform metadata, unavailable model catalog, and
   malformed optional fields without crashing or silently broadening dispatch.
9. Confirm Claude, Codex, OpenCode, Pi, and tmux behavior remains correct.

## Browser verification

Follow the isolated-stack workflow after web typecheck and owning tests pass.
Use a seeded fixture and a harmless image asset. For both Cursor and Grok:

- Create/select a native draft, attach the image, and wait for saved revision.
- Switch environments so the original composer can unmount, then return.
- Hard reload the browser so the in-memory store cannot conceal missing recovery.
- Verify attachment preview/name, text, annotations if present, and send controls.
- Reload a second time after autosave to prove the recovered image was re-saved.
- Exercise the pre-session picker with the same platform selected in metadata.

No paid model turn is needed to prove draft persistence. Sending can be covered
with existing synthetic provider tests; if doing a live smoke, scope it to the
fixture. Check keyboard attachment removal and a narrow viewport if shared UI
imports or behavior change.

## Acceptance

- [x] Cursor and Grok images survive both hydration and subsequent publication.
- [x] Native attachment policy has one shared capability source.
- [x] Structural validation, draft conflicts, and local-typing protection remain.
- [x] Model uncertainty does not become destructive draft filtering.
- [ ] Focused web tests, web typecheck, and isolated reload/inactive QA pass.
- [x] No storage migration or attachment file rewrite is introduced unnecessarily.

