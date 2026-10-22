# Design agent conversation links

Checked against `main` at `2459b05c` (2026-10-15).

A design canvas remembers the conversations that worked on it, and **Ask
agent** and **Use as implementation reference** put revisioned design context
into a conversation's draft. Today those links point at pane tabs, not native
sessions, so closing the agent tab loses the way back even though native
sessions can be resumed. Design context is also plain text, not a removable
annotation, when it goes into a brand-new conversation.

## Current state

- `DesignSessionLink` (`packages/protocol/src/design-operations.ts`) has a
  required `tabId` and an optional `sessionId`, plus platform, role (design or
  implementation), creation time and an optional checkpoint. A canvas keeps at
  most `DESIGN_LIMITS.sessionLinksPerCanvas` (8) in its private record, and
  the dialog asks which link to replace when it is full.
- `design_session_link` (`apps/backend/src/core/design/commands.ts`) accepts
  `sessionId`, but no caller sends it: `designApi.linkSession`
  (`apps/web/src/lib/design-client.ts`) is called with only `tabId`,
  platform, role and label, from `DesignAgentDialog.tsx` and the staged launch
  in `DesignWorkspaceDialog.tsx` / `design-launch.ts`.
- `DesignAgentDialog.tsx` derives `LinkStatus` (`open`, `closed`, `checking`)
  from whether the linked tab is an `agent-native` tab in the local pane
  layout. A closed tab shows "Closed — conversation ended" and the dialog
  offers a new conversation.
- Native tabs already carry `NativeAgentTabData.sessionId` and
  `requireExistingResumeSession` (`packages/protocol/src/native-agent.ts`),
  and native sessions can be reopened through
  `apps/web/src/components/chat/NativeResumeSessionDialog.tsx`.
- `planDesignDraft` (`apps/web/src/components/design/design-agent-context.ts`)
  takes `inlineText: true` when the target tab has no platform yet, because
  that composer sends text only. The context is then written as inert visible
  text instead of a `design` annotation chip.

## Outstanding work

### Code

1. **Persist the native session identity.** Once the linked conversation has
   a durable session id, record it on the link (`sessionId` through
   `design_session_link`). A temporary tab id may stand for a pending launch,
   but must not stay the only persisted reference. Validate environment
   ownership and session existence on resume through the existing
   native-agent session APIs.
2. **Offer Resume conversation.** When the linked tab is closed but its
   session can be resumed, offer **Resume conversation** before a new one. It
   reopens through ordinary native-agent behaviour (a tab with
   `requireExistingResumeSession`, so a failed resume never creates an empty
   replacement) and never resends the design's initial prompt.
3. **Report link state from authoritative projections.** Distinguish
   temporarily unavailable, detached, archived or closed, and missing
   sessions from the native-agent projections
   (`apps/web/src/stores/nativeAgentProjectionStore.ts` and the discovery
   APIs), without polling tab-facing liveness routes or defeating idle
   detachment.
4. **Drop the inline-text path.** Once the new-tab composer supports
   annotations (shared composer work, not design-specific), remove
   `inlineText` from `planDesignDraft` so design context is a removable chip
   everywhere.
5. **Test concurrent Resume.** Two clients press Resume (or open the same
   link) at once: both reuse the same association and focus, and no second
   generation is dispatched. No such test exists.

### Qualification

- Create a design conversation, close its tab, reopen the canvas and resume:
  same session, no duplicate initial prompt.
- A missing or detached session and a disconnected backend each lead to the
  right recovery, never a silent replacement session.
- The live Claude and Codex design-tool cycle is tracked in
  [0036-design-canvas-qualification.md](0036-design-canvas-qualification.md).

## Constraints and rationale

- A link stores only the association: backend, environment and canvas
  identity, native session identity, platform, role, creation time and an
  optional originating checkpoint. Never transcripts, credentials or a copy
  of native-agent status.
- Deleting a canvas removes or fences its links but never deletes a
  transcript. Closing a design tab does not stop its agent.
- Import and duplicate carry no active links; a user attaches a conversation
  explicitly.
- No design-specific auto-approval. Handoff never submits, approves, commits
  or deploys.
- Design text and HTML are user content, never trusted tool instructions.
  Context says which revision it depicts, and the backend still revision-checks
  every edit; the prompt guidance is not the concurrency boundary.

## Open questions

- Should a link survive tab closure at all? `design-canvas.md` currently says
  "Closing a native tab ends its conversation", and the dialog follows that.
  If that is the intended product rule, drop items 1–3 and keep 4 and 5. The
  caller inventory for close and retention is in
  [`agent-engines.md` → Who calls close](../../architecture/agent-engines.md#who-calls-close).

## Related

- [0002-session-lifecycle-consistency.md](../agent-engines/0002-session-lifecycle-consistency.md) for
  close and retention semantics, and
  [0006-session-titles-and-history.md](../agent-engines/0006-session-titles-and-history.md) for
  archive behaviour.
- [0036-design-canvas-qualification.md](0036-design-canvas-qualification.md).
- [`design-canvas.md`](../../architecture/design-canvas.md) ("Agent context").

## Replaces

- `docs/improvements/design-space/plan/11-agent-context-and-handoff.md`
  (session association, resume and the new-tab limitation; the rest is done)
- `docs/improvements/design-space/plan/00-index.md` (the annotation-pills
  deferral)
- `docs/improvements/design-space.md` (the unfinished part of finding U4)
