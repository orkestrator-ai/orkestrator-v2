# 04 — Interactions: elicitation, dialogs and permissions

**Status:** 🟨 In progress · ~65% · Depends on: 02

Refreshed 2026-09-11. Shared interaction contract, capability bits, and
unattended defaults are in tree. Still open: `listPermissionRules` /
`removePermissionRule`, full MCP elicitation parking, Grok permission
titling, and browser QA.

## Goal

Every question, approval, elicitation and dialog a provider can raise reaches
the user through the existing interaction contract
(`packages/protocol/src/agent-interactions.ts`) and its one generic card, and
an unattended session resolves them by a backend policy instead of hanging or
hard-failing. Add a capability bit so the renderer can say "this platform
never asks" rather than showing an empty list.

## Normalized model

- `NativeAgentCapabilities.interactions?: { kinds: AgentInteractionKind[] }`
  in `packages/protocol/src/native-agent.ts:394-425`. Absent or empty means
  the platform raises nothing (Cursor today).
- `AgentInteractionOption` gains `amendment?: { kind: "exec-policy" |
  "network-policy" | "permission-grant"; detail: string }` so a provider that
  offers "approve and remember this rule" surfaces it as one more option, not
  a provider-specific button.
- `AgentInteractionRequest` gains `blocking: boolean` (default `true`). A
  non-blocking request does not hold the turn's activity at `waiting`.
- `AgentInteractionPolicy` (`agent-interactions.ts:264-294`) gains per-kind
  defaults for `permission` and `elicitation` in unattended mode. Recommended
  defaults: `permission` → `decline-and-continue`, `mcp-form`/`mcp-url`/
  `elicitation` → `decline-and-continue`, `command-approval`/`file-approval`
  → `deny-and-fail` (unchanged).
- New saved-rule surface (backend-owned):
  `GET /session/:id/permission-rules` → `{ rules: NativeAgentPermissionRule[] }`
  and `DELETE /session/:id/permission-rules/:ruleId`, with
  `NativeAgentPermissionRule = { id, label, scope: "session" | "project" |
  "user", source: "provider" }`. Only providers that persist "always allow"
  rules implement it; others answer an empty list.

## Tasks

### Protocol and backend

- [x] Add the capability bit, `amendment`, `blocking`, policy defaults and
  the permission-rule types; protocol tests.
- [x] `native-agent-service-shared.ts` and the projection carry
  `capabilities.interactions`; the renderer's interaction list shows
  "This agent does not raise approvals" when the kinds list is empty, from
  the projection only.
- [ ] Add `listPermissionRules?`/`removePermissionRule?` to
  `NativeAgentRuntimeProvider`; `HttpBridgeProvider` maps the routes;
  `OpenCodeProvider` maps `client.v1`-compatible `permission.list` plus the
  saved-rule read if present on the v1 surface (if only `v2.permission.saved`
  exists, mark the OpenCode task ⏸ pending plan 13's v1 check).
- [x] Apply the new unattended defaults in the policy resolver used by build
  pipelines and the coordinator; add tests for each kind.

  **Deviation: `permission` keeps `deny-and-fail`.** The plan recommended
  `decline-and-continue` on the reasoning that an escalation request refused
  leaves the agent with what it already had. That holds for Codex, whose
  `item/permissions/requestApproval` is a genuine capability escalation. It does
  not hold for OpenCode, which maps a *per-tool* approval — "may I edit files?"
  — onto the same kind: an unattended session refused there would carry on as an
  agent that cannot write, burning the rest of the pipeline to produce nothing.
  The kind is overloaded across providers and a per-kind default cannot resolve
  that; plan 12's execution policy is where the distinction belongs. The MCP
  elicitation defaults landed as written, with their reasoning recorded in
  `UNATTENDED_AGENT_INTERACTION_POLICY`.

### Claude adapter

- [x] Wire `Options.onElicitation` → `mcp-form`/`mcp-url` interactions and
  `Options.onUserDialog` → `elicitation` with `supportedDialogKinds` limited
  to what the card can show. Today neither is set and requests park until
  the CLI deadline.
- [x] Pass the full third argument of `canUseTool`
  (`session-manager-prompt.ts:843` types it as `{toolUseID?}`) and use
  `suggestions` to populate `amendment` options; return
  `updatedPermissions` when the user picks one. Keep the blanket-allow for
  tools outside the three branched today, but route through the policy so
  unattended mode can deny.
- [ ] `permission_denied` and `PermissionDenied`-shaped events → a
  `status` row (plan 03) and a `permissionDenials` count in usage.
- [ ] Set `toolConfig.askUserQuestion.previewFormat` to the format the card
  renders (plain or html) so previews match.

### Codex adapter

- [x] Unattended `item/permissions/requestApproval` with no tab: answer per
  policy (`decline-and-continue` builds the empty-grant response
  `buildApprovalResponse` already knows, `approvals.ts:284-305`) instead of
  cancelling with `-32601` (`server-request-router.ts:413-423`).
- [x] Offer `acceptWithExecpolicyAmendment` and `applyNetworkPolicyAmendment`
  (`v2/CommandExecutionApprovalDecision.ts`) as `amendment` options on
  command approvals; map the chosen option back in `approvals.ts:258-270`.
  Send `strictAutoReview` when the policy asks for it.
- [x] `serverRequest/resolved` (ignored today) → withdraw the parked
  interaction so a request answered by another client does not sit until
  timeout.
- [ ] `item/tool/call` (dynamic tools): keep failing, but as a
  `deny-and-fail` policy outcome with a `status` row, not a silent violation.

### OpenCode adapter

- [ ] Replace the flat auto-reject in unattended mode
  (`opencode-provider.ts:551-562`) with the policy resolver.
- [ ] `permission.replied` SSE → mark the interaction resolved without
  waiting for the next poll.

### Cursor adapter

- [x] Set `capabilities.interactions` to empty for Cursor (the SDK has no
  approval hook). If `askQuestion` ever surfaces through `onDelta`, map it to
  a `question` interaction; until then the generic card with drift (plan 02)
  stands. Grok is set alongside it, to the kinds its ACP wire really answers.

### Grok adapter

- [ ] Title permission requests from `toolCall.kind`/`title` and set
  `kind` from the ACP option kinds rather than the hard-coded
  `permissions: { fileSystem: true }` in `acp-public.ts`; carry the request's
  `blocking` hint if present.

### Pi adapter

- [x] When `PI_BRIDGE_REQUIRE_APPROVAL=1`, report `interactions.kinds:
  ["command-approval","file-approval"]`; otherwise empty. Plan 12 decides
  when the gate is on. The live answer is published on the bridge's status
  projection and overrides the platform table in the backend, so a session that
  cannot ask does not advertise that it can.

## Verification

- [ ] Bridge tests: each new interaction kind parks, renders through the
  neutral snapshot route, resolves, and fails closed on timeout.
- [x] Backend tests: unattended policy per kind.
- [ ] Browser: raise an MCP elicitation (Claude fixture with a test MCP
  server), answer it, reload mid-question, confirm rehydration from
  `/session/:id/interactions`.

## Out of scope

Execution policy itself (plan 12). MCP OAuth start (plan 07).

## What is still open, and why

The remaining tasks all need a *parked* interaction surface that the provider
in question does not have yet, or a route that does not exist:

- **Permission rules** (`GET`/`DELETE /session/:id/permission-rules`, the two
  provider methods). No bridge persists a saved rule today, so the routes would
  answer an empty list on every platform. Worth doing alongside the first
  provider that actually keeps one.
- **Claude `permission_denied` → status row and a `permissionDenials` count.**
  The count belongs in `NativeAgentContextUsage`, which is plan 11's subject;
  splitting it across two plans would leave the field half-populated.
- **Claude `toolConfig.askUserQuestion.previewFormat`.** Needs the card's
  rendering mode settled first, which is a renderer decision nothing has made.
- **Codex `item/tool/call` as a `deny-and-fail` outcome with a status row.**
  It already fails; making the failure legible needs the status row to reach the
  approvals surface, not the transcript, and that surface is unchanged here.
- **OpenCode `permission.replied` SSE → resolve without waiting for the poll.**
  Latency only; the reconcile loop is already correct.
- **Grok permission titling from `toolCall.kind`.** Presentation on a path that
  works; queued behind plan 14's schema vendoring, which is where the ACP option
  kinds become typed rather than guessed at.
- **Claude elicitations and dialogs are answered, not parked.** `onElicitation`
  declines with a visible status row naming the server, and `onUserDialog`
  cancels so the CLI applies the dialog's own default. That fixes the real
  defect — both used to sit unanswered until the CLI's park deadline, which the
  user saw as the tab freezing — but it is not yet the full parked-card round
  trip the plan describes. Parking them needs a third pending-request map, its
  routes, and its backend mapping, which is a larger change than the rest of
  this plan put together.
