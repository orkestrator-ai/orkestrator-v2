# 08 — Implement OpenCode configuration management

Status: done for durable CRUD across every file layer the pinned binary reads (remote/org configuration
not modelled); apply reports restart-required (no directory reload implemented, no `applied` evidence).
Depends on: 01–05. [Plan index](00-index.md).

## Existing owners

- `apps/backend/src/core/opencode-capabilities.ts`: MCP status and connection actions.
- `opencode-provider.ts`: session/provider lifecycle and `mcp.tools.changed` handling.
- `commands-servers.ts`: OpenCode process lifecycle and injected agent tools.
- `extension-discovery.ts`: fallback configuration discovery.
- `opencode-provider-streaming.test.ts`, `opencode-provider-dispose.test.ts`,
  `commands-agent-tools.test.ts`: relevant existing regression suites.

Use `@opencode-ai/sdk/v2/client` at the repository pin. Do not move production
onto future OpenCode session/API v2 as part of this feature.

## Persistence adapter

1. Resolve the exact user/custom/project JSON or JSONC source through the target
   resolver. Include config layering and directory identity in provenance. Do not
   copy the merged `config.get` result wholesale into a project file.
2. Edit the source `mcp` subtree with comment-preserving operations and native
   field mapping. Stdio maps to the native local command array; HTTP maps to the
   native remote shape. Preserve environment/header references without resolving
   or returning their values.
3. Implement add/update/rename/remove with the shared source-revision checks.
   Preserve unknown options and the rest of the application's OpenCode config.
   Determine whether a merged lower source resurfaces after removal and preview it.
4. Implement persisted enable state separately from `mcp.connect/disconnect`.
   If an inherited entry needs a masking override, use only the pinned provider's
   proven representation and clearly label it as an override.
5. Reject fake delete behavior such as setting an entry to undefined in an SDK
   request unless step 01 proves persistence and native source semantics. A
   disconnected server remaining in config is not removed.

## Runtime application

Select one evidenced adapter strategy per pinned version:

- Use a supported directory-scoped SDK config update/reconcile if it preserves
  all sessions and can remove old definitions/tools.
- Otherwise, queue a safe provider process or directory lifecycle boundary and
  report pending/restart-required until it occurs.

`mcp.add`/existing `POST /mcp` can establish runtime entries, but must not be assumed
to persist them or provide a complete replace/delete API. Call the native writer
first, then use the validated runtime sequence. On update, do not leave both the
old and new client/tool registrations alive.

Map affected runtimes by OpenCode directory and owning server process. An edit
from one chat tab may affect another; block broad disposal/restart until all
affected sessions reach a safe boundary. Preserve session ids, pending questions,
permissions and active SSE state. Scope refresh events appropriately rather than
invalidating only the initiating tab.

Reconcile Orkestrator's runtime-only MCP injection after a provider reload that
clears it. Use the existing trusted connection source and `oauth: false` behavior.
Do not save the injected bearer in JSON and do not let a user definition claim
the reserved name. Restoring injection is separate from retrying user prompts.

## Status and authentication

Refresh status from `mcp.status` after the validated application boundary and on
`mcp.tools.changed`. An SDK response containing `.error` must be handled even if
the transport returned successfully. Poll only if necessary, with a finite budget
and no session liveness side effects.

The current backend uses `mcp.auth.start` and returns a URL. Trace how completion
actually reaches the provider: callback, provider listener or another SDK method.
Do not add an in-app sign-in success state until the completion path is tested.
Remote-browser and container callback addresses must refer to the execution host,
not the browser's loopback. Where that path is unavailable, expose a truthful
external-authentication instruction instead of a broken button.

Removing a definition does not remove `mcp-auth` credentials automatically.
Endpoint changes must not apply credentials to a different destination through
an application-level cache; leave token audience/ownership to the provider and
invalidate our pending auth operation appropriately.

## Rejection and error handling

Any added abort signal must have owned rejection handlers on every consumer.
Preserve the patched SDK SSE cancellation behavior; use the real-client disposal
regression to catch abort paths that mocks cannot reproduce. Configuration errors
must degrade one feature, not terminate the backend.

Redact provider error text before it enters status, operation responses or logs.
Current error-length limits are not sufficient when an SDK error echoes headers
or a submitted URL. Use synthetic sentinel credentials in failure tests.

## Test matrix and acceptance

- [ ] JSON and JSONC CRUD preserve comments, unknown options and other config.
- [ ] Local command arrays and remote fields round-trip without shell parsing.
- [ ] Save survives provider restart; remove eliminates effective tools unless an
  explicitly previewed inherited definition takes over.
- [ ] Two sessions in one directory cannot be interrupted by a unilateral reload.
- [ ] Runtime-only Orkestrator injection is restored and never persisted.
- [ ] Auth start, completion, cancellation, stale operation and remote callback
  limitations are represented accurately.
- [ ] SSE abort/dispose and SDK `.error` responses are handled without unowned rejections.
- [ ] Runtime status/projection refresh recovers after inactive-tab navigation.

Next adapter: [09 — Cursor](09-cursor.md).
