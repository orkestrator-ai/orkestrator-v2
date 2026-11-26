# Retire the compatibility paths that need a wire or schema change

## Task analysis

Analysed 2026-11-26 against main at `f80c75e10`. Created by the build that
did 8304 (retired 2026-11-26) task 1: the contract CI job now applies a
one-time support floor at v2.39.1-beta, the first release built from the
2026-11-14 legacy-retirement sweep, and the adapters, capability commands
and commands that floor freed were deleted
([version-compatibility.md](../../architecture/version-compatibility.md#the-support-window)).
The paths below were listed in 8304 too, but removing them changes what a
current-version command answers or accepts, which that build was told not to
do, so they move here.

### Tasks

1. **Refuse a workspace client's unchanged global-settings write instead of echoing it**: the config-echo answer. Status: open.
2. **Drop the retired setting keys a workspace client may still send**: `experimentalCodexRawEventLogging` and `openCodeProtocol`. Status: open.
3. **Make the optional result fields every supported backend sets required**: `legacyRuntimes`, `deleteFailure` and `deletingSince`. Status: open.
4. **Drop result fields no backend sets any more**: `diffScopeUnsupported` and `instructionsIgnored`. Status: open.
5. **Remove the renderer branches for capabilities that are now constant**: the browser-copy, sound, live-update, handoff and folder-digest fallbacks. Status: open.

### 1. Refuse a workspace client's unchanged global-settings write instead of echoing it

**Problem.** A workspace client (a client grant, or the relay) may not change
global settings, but an `update_global_config` or `patch_global_config` that
would change nothing is answered with the current settings instead of being
refused with 403 (`isGlobalConfigEcho` in `nodes/workspace-grant-scope.ts`,
`answerConfigEcho` in `nodes/node-relay.ts`, `GatewayHandlers.handleInvoke`,
counter `workspace-grant.config-echo`).

**Context.** The register row in
[version-compatibility.md](../../architecture/version-compatibility.md#register)
says it serves command nodes through v2.35.1-beta, whose realms wrote a
favourite to the command node and then sent the leaf's own settings back
unchanged, and that it retires once the floor is at or above v2.36.0 and the
counter is quiet. The one-time floor (v2.39.1-beta) is above v2.36.0.

**Investigation.** Not done beyond the register row. Before removing it,
check that no renderer from v2.39.1-beta sends an unchanged settings write
through a workspace grant (`git grep update_global_config v2.39.1-beta --
apps/web/src` still finds callers in `config-integrations.ts` and
`portal/command-node-config.ts`), because refusing it changes the answer of a
current-version command for any client that does.

**Decisions.**

- **How to retire it?**
  - **Remove the echo once the check above finds no v2.39.1-beta caller that sends an unchanged write through a grant (recommended).**
    - Pros: the condition the register row names is met; no domain bump, since the gateway decides from the raw arguments.
    - Cons: needs the caller check first.
  - **Keep it until the 60-day window passes a Stable release past v2.39.x.**
    - Pros: no investigation.
    - Cons: keeps a path that the register row already says can go.

### 2. Drop the retired setting keys a workspace client may still send

**Problem.** `RETIRED_GLOBAL_SETTING_KEYS` lets a workspace client's write
carry `experimentalCodexRawEventLogging` or `openCodeProtocol` without being
refused, and the `config` schema keeps `openCodeProtocol` (the native-session
record keeps its `openCodeProtocol` marker too).

**Context.** Register rows "Clients that still send
`experimentalCodexRawEventLogging`" and "Clients that still send
`openCodeProtocol`". Nothing reads either key. Removing a field from a
command's schema is a schema change of a current-version command.

**Investigation.** Not done. Check whether the settings forms of v2.39.1-beta
and later still send either key; if none does, removing them from the set is
safe for every supported client, and the schema fields can go with a
`config` (and `native-sessions`) version bump or once no in-window release
sends them.

**Decisions.**

- **How to retire them?**
  - **Remove both keys from the set when no supported form sends them, and the schema fields at the next `config` bump (recommended).**
    - Pros: no bump only for this; the set is the part that matters for refusals.
    - Cons: the schema fields stay until a bump.
  - **Bump `config` and `native-sessions` now to drop the fields.**
    - Pros: removes everything at once.
    - Cons: adds an older-version adapter per domain, which the 60-day window then keeps.

### 3. Make the optional result fields every supported backend sets required

**Problem.** `legacyRuntimes` on `docker_cleanup_preview` (read by
`DockerCleanupReview.tsx`) and `deleteFailure`/`deletingSince` on environment
summaries (`environment-row-facts.ts`) are optional, so the renderer keeps a
branch for backends that never set them.

**Context.** Register rows "Backends whose `docker_cleanup_preview` has no
`legacyRuntimes`" and "Machines whose environment summaries have no
`deleteFailure` or `deletingSince`".

**Investigation.** Not done. A field can become required only if every
backend at or above the floor sets it; check the v2.39.1-beta backend. Making
a result field required changes the result schema of a current command.

**Decisions.**

- **How to retire them?**
  - **Make them required once the v2.39.1-beta backend is shown to set them, and drop the renderer branches (recommended).**
    - Pros: removes the renderer branches with no bump if every supported backend sets them.
    - Cons: needs the check first.
  - **Leave them optional.**
    - Pros: no work.
    - Cons: keeps renderer branches for backends nobody runs.

### 4. Drop result fields no backend sets any more

**Problem.** `diffScopeUnsupported` in the coordinator worker-changes result
(`coordinator/schemas-controller.ts`) and `instructionsIgnored` in the
native-sessions dispatch and session-action outcomes
(`native-sessions/schemas.ts`) are never set, but stay in the registered
result schemas.

**Context.** 8304 kept them so the registered result schemas were
unchanged.

**Investigation.** Not done. Check that no renderer from v2.39.1-beta needs
the field to be declared (an absent optional field decodes the same).

**Decisions.**

- **How to retire them?**
  - **Remove both fields from the schemas and regenerate the manifest (recommended).**
    - Pros: nothing sets them, so no answer changes on the wire.
    - Cons: the result schema digests change.
  - **Keep them.**
    - Pros: no work.
    - Cons: dead schema fields.

### 5. Remove the renderer branches for capabilities that are now constant

**Problem.** With adapter 0 deleted, the `config`, `native-sessions` and
`files` clients answer the client-state, sync and handoff capabilities from
the domain version, so they are always on. Renderer code still tests them:
`coordinatorPaneLayoutStore.ts` (`!capabilities.coordinatorPaneLayouts`),
`nativeNoticeDismissalStore.ts` (`!capabilities.noticeDismissals`),
`useNotificationSoundService.ts` (`environmentAttention`),
`useNativeAgentSession.ts` (the separate transcript and state reads when
`nativeLiveUpdateSupported` is false), `useAgentHandoff.ts` (delivery by the
renderer), `createAgentHandoff` in `lib/agent-handoff.ts` (the "needs a newer
backend" answer to an `unknown-command`, for backends before
`create_agent_handoff`) and `normalizeFileSubtreeSnapshot` in `lib/backend/files-sessions.ts`
(a backend that ignores `knownDigest`).

**Context.** The register rows for these paths moved to Retired on
2026-11-26 ([version-compatibility.md](../../architecture/version-compatibility.md#retired)):
the old path is unreachable, but the branches were left so the floor change
stayed reviewable. No wire behaviour changes when they go.

**Investigation.** Not done beyond locating the branches above. Each one's
owning tests exercise the old path with a fake capability answer and go with
it.

**Decisions.**

- **How to remove them?**
  - **Delete each branch and its tests, keeping the capability types until no caller reads them (recommended).**
    - Pros: pure dead-code removal; small, independent edits.
    - Cons: touches several stores and hooks.
  - **Leave them.**
    - Pros: no work.
    - Cons: code paths nothing can reach.

## Constraints and rationale

- The forward policy recorded with the one-time floor applies: above
  v2.39.1-beta the 60-day window still guards every change, so a removal that
  an in-window release would notice needs a domain bump and an older-version
  adapter, or must wait for the window.

## Related

- [version-compatibility.md](../../architecture/version-compatibility.md#register):
  the register rows these tasks retire.
- [4740](4740-workflow-vocabulary-stage-two.md) task 6: another rename the
  window still governs.

## Replaces

- 8304 (retired 2026-11-26): the items of its task 1 that the one-time floor
  did not free (`git show f80c75e10:docs/todo/cross-cutting/8304-contract-pinned-compatibility-paths.md`).
