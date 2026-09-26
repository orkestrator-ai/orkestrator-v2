# 09 — Define and implement consistent conversation retention on close

Status: Planned; product decision open.  
Depends on: [04](04-durable-session-lifecycle-acknowledgements.md),
[05](05-cursor-permanent-close-and-late-work-ownership.md).  
Finding: INC-08.

## Outcome and decision boundary

The user should know whether closing a tab retains a resumable conversation.
Provider-specific HTTP DELETE behavior must not make that decision implicitly.

Recommended target: **ordinary tab close releases runtime resources and retains
conversation history**. Permanent conversation deletion remains an explicit,
separately named operation only where supported and authorized. In particular,
Codex `thread/delete` remains prohibited by AGENTS.md; this plan does not add it.

This recommendation is not a recorded product decision. Before implementation
changes destructive semantics, record the maintainer's choice, rationale, and
affected entry points below. Planning and the other correctness fixes do not
need to wait for that choice.

| Decision record | Value |
| --- | --- |
| Ordinary close retention | Open; recommend preserve history |
| Existing explicit delete controls | Inventory before implementation |
| Automated workflow cleanup retention | Open; inventory separately from user tab close |
| Unsupported/older bridge behavior | Recommend fail visibly without destructive fallback |
| Maintainer decision/reference | Not yet recorded |

If the chosen policy instead preserves provider-specific destructive close,
use the alternative path at the end of this step. Do not implement both policies
through an unexplained global flag.

## Owners and current paths

- [Backend tab teardown](../../../../apps/backend/src/core/commands-registry-teardown.ts)
  sends DELETE directly and persists teardown intents.
- [Provider contract](../../../../apps/backend/src/core/agent-provider-contract.ts)
  exposes `closeSession`; [HTTP provider](../../../../apps/backend/src/core/http-bridge-provider.ts)
  implements it with DELETE.
- [OpenCode provider](../../../../apps/backend/src/core/opencode-provider.ts)
  currently implements close using `client.session.delete`.
- [Multi-review cleanup](../../../../apps/backend/src/core/multi-review-service.ts)
  also calls `provider.closeSession`; it is a separate caller to classify.
- [Shared teardown inputs](../../../../packages/protocol/src/tab-teardown.ts).
- [Claude session routes](../../../../bridges/claude-bridge/src/routes/session.ts)
  and [durable deletion](../../../../bridges/claude-bridge/src/services/session-manager-persistence.ts).
- [Codex runtime release](../../../../bridges/codex-bridge/src/app-server-runtime-sessions.ts).
- [Cursor routes](../../../../bridges/cursor-bridge/src/http.ts),
  [Pi routes](../../../../bridges/pi-bridge/src/http.ts), and
  [Grok ACP routes](../../../../bridges/acp-bridge/src/acp-http.ts).
- [Living architecture](../../../architecture/agent-engines.md).

## A. Inventory the complete lifecycle surface

- [ ] Find every `closeSession`, session DELETE, `teardown_tab`, orphan cleanup,
  workflow cleanup, explicit history deletion, and environment-removal caller.
  Record which action the user or workflow actually requested.
- [ ] Separate logical tab identity, bridge session identity, vendor conversation
  identity, and transcript cache. Specify which survives each action.
- [ ] Check multiple tabs referencing the same vendor conversation. Closing one
  tab must not stop/delete a conversation still owned by another tab.
- [ ] Inspect Grok's actual release behavior and pinned OpenCode lifecycle APIs.
  Do not infer non-destructive close support from a method name. Use current
  documentation and the pinned SDK source when vendor semantics are needed.
- [ ] Verify native and tmux resume listings after close. Their implementation
  can remain different, but user-facing retention must be accurately described.
- [ ] Inventory automatic workflow sessions separately. Preserving history may
  increase retained provider data; document any existing cleanup/retention policy
  without silently deleting historical conversations as part of this change.

## B. Specify a non-destructive close contract

For the recommended retention policy, define the following lifecycle distinction
in backend/provider terms before changing routes:

| Operation | Execution | Active mapping/resources | Vendor history |
| --- | --- | --- | --- |
| Visibility unmount | Continues | Retained | Retained |
| Idle detach | Already idle | Release expensive handle; retain recovery identity | Retained |
| Close tab/session ownership | Stop owned work, settle approvals | Retire this tab's ownership durably | Retained |
| Explicit delete history | Provider-specific, deliberate destructive action | Reconcile every relevant owner first | Deleted only where supported |

- [ ] Make `closeSession` mean the non-destructive row, or add a clearly named
  operation and migrate all relevant callers. Do not leave one path using the
  new meaning while direct teardown still uses destructive DELETE.
- [ ] Define affirmative close capability/version evidence for managed bridges.
  Missing capability is unknown/unsupported, not permission to guess. Reuse an
  existing negotiation surface if suitable; otherwise document the additive
  contract in the shared protocol and test it.
- [ ] Prefer an explicit route such as `POST /session/:id/close` where existing
  DELETE means permanent deletion. This route name is proposed, not present
  behavior. Leave the old destructive operation unambiguous for explicit callers.
- [ ] Return success only after runtime ownership is safely closed and required
  metadata is published. Reuse step 05's late-work and failure semantics.
- [ ] Define unknown-session close as idempotent only after route support is
  established. A bare 404 from an older bridge is not evidence that the session
  is gone. Never fall back from an unsupported close route to destructive DELETE.
- [ ] Keep the existing backend teardown intent until the close is confirmed.
  Version any new intent semantics so an old pending DELETE intent is not silently
  replayed as an unintended destructive action after upgrade.

## C. Implement each provider at its actual boundary

| Provider | Planned adapter work for preserve-on-close |
| --- | --- |
| Claude | Add release/close path that stops query controls, denies pending interactions, settles dispatch claims, retires bridge ownership/preferences as appropriate, and does not call SDK `deleteSession` |
| Codex | Reuse reference-counted release/unsubscribe; retain last-tab stop behavior and approval rules; never introduce `thread/delete` |
| Cursor | Reuse step 05 permanent bridge close; keep SDK conversation store intact |
| Pi | Reuse permanent bridge close and preserve the Pi JSONL conversation; verify cancellation and publication semantics |
| Grok | Verify ACP release/detach and vendor history retention; implement only supported operations and expose limitations honestly |
| OpenCode | Stop the owned turn and release backend subscriptions/registration without `client.session.delete`; keep provider history and necessary resume metadata |

- [ ] For OpenCode, distinguish shared server/session ownership from one tab's
  registration. End only the closing owner's work/subscription. Restore temporary
  review permissions and workflow ownership through the established service path.
- [ ] For Claude, keep resumable SDK identity discoverable without resurrecting
  the closed logical tab during session-catalog reconciliation. A vendor history
  entry is not an active-tab mapping.
- [ ] Retire agent-mail/MCP tab credentials and pending UI projections after the
  ownership close, while retaining any vendor conversation metadata required for
  deliberate future resume. Never persist rotated bearer tokens.
- [ ] Preserve uncertain execution as visible/incomplete if a provider cannot
  prove stop. Resource release and conversation retention are separate questions.
- [ ] Adapt multi-review cleanup only after its desired retention is recorded.
  Do not globally change all cleanup callers by renaming one method and assuming
  they share the tab-close product intent.

## D. UI, migration, and compatibility

- [ ] Audit tab-close labels, context menus, history deletion controls, confirmation
  copy, resume dialogs, and errors. Ordinary close should not imply permanent
  deletion under the recommended policy.
- [ ] Do not add a new destructive deletion button as incidental scope. Existing
  explicit deletion controls must use the deliberate delete operation; a larger
  history-management UI is a separate product task.
- [ ] Keep older bridge/runtime behavior non-destructive. When close support is
  unavailable, report the limitation and leave recoverable ownership/intent;
  offer the existing bridge upgrade/restart path where appropriate.
- [ ] Document that history already deleted by old behavior cannot be recovered
  by this migration. Do not manufacture empty replacement conversations and call
  that restoration.
- [ ] Check downgrades: an older backend must not reinterpret a new intent as
  authorization to delete history. If safe downgrade is unavailable, state the
  minimum compatible version and refuse the incompatible operation explicitly.
- [ ] Update the architecture guide and any operator text that equates close
  with deletion. Keep the original review as historical evidence.

## Regression and real-stack coverage

For each platform, test create → completed synthetic turn → close → list/resume.
Assert preserved provider identity/history where supported, absent active-tab
mapping, released resources, and no stray prompt. Test last-reference close
separately from closing one of two references.

Add cases for close while running, startup close, approval pending, failed close,
retry, unknown session, legacy bridge without the route, lost response after
successful close, and backend restart with a durable teardown intent. The
unsupported-route case must explicitly assert that no DELETE fallback occurs.

Use focused backend teardown/provider tests and bridge route tests before the
isolated browser cycle. Browser QA must cover close, navigate away, reload,
resume listing, deliberate resume, and any existing explicit deletion flow.
Use only seeded fixture conversations for destructive cases.

## Alternative if provider-specific destructive close is retained

If that is the recorded product choice, keep it explicit in a capability/retention
descriptor and make the UI communicate the consequence before the action. Test
that the backend-selected descriptor matches each provider operation, survives
reload, and cannot be guessed from provider labels in multiple UI components.
Still fix INC-02 independently, and still distinguish runtime close failure from
successful history deletion. Do not mark this finding resolved solely because
the discrepancy is mentioned in an internal Markdown file.

## Acceptance

- [ ] The product decision and affected caller inventory are recorded.
- [ ] Shared teardown and provider cleanup no longer imply contradictory meanings.
- [ ] Every provider follows the selected policy or exposes an actionable limitation.
- [ ] Older route/capability behavior cannot trigger destructive fallback.
- [ ] Close, idle detach, unmount, and explicit deletion remain distinct.
- [ ] Cross-provider tests and required isolated browser QA pass.
- [ ] Codex `thread/delete` remains absent, and already-deleted history is not
  misrepresented as recoverable.

