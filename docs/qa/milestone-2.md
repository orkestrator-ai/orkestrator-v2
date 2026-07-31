# Milestone 2 — Consistent interactive presentation

Status: Not started

Depends on: Milestone 1

Unblocks: Milestone 6

## Outcome

Give every app-owned interactive request consistent blocking-card semantics,
authoritative deadlines, answer fidelity, secret handling, recovery, and
accessibility without changing unattended-workflow behavior.

## Scope

Primary files:

- `apps/web/src/components/chat/BlockingPromptCard.tsx`
- `apps/web/src/components/chat/QuestionCard.tsx`
- `apps/web/src/hooks/usePromptDeadline.ts`
- `apps/web/src/stores/promptDraftStore.ts`
- `apps/web/src/components/codex/CodexInteractionCard.tsx`
- `apps/web/src/components/codex/CodexQuestionCard.tsx` (new, if split)
- `apps/web/src/components/claude/ClaudeQuestionCard.tsx`
- `apps/web/src/components/claude/ClaudeTmuxChatTab.tsx`
- `apps/backend/src/core/tmux.ts`
- `bridges/claude-bridge/src/routes/session.ts`
- Codex interaction resolution/transcript code

## Shared shell checklist

- [ ] Extend the existing blocking shell with consistent title, description,
      authoritative countdown, expired/withdrawn state, inline retryable error,
      and action layout.
- [ ] Keep `QuestionCard` as the shared multi-question wizard.
- [ ] Standardize applied, stale, invalid, retryable-failure, and withdrawn
      outcomes without letting optimistic UI declare final success.
- [ ] Disable submit/dismiss while a provider response is in flight.
- [ ] Reconcile after an ambiguous transport error before offering a retry.
- [ ] Pass `role="group"` and a useful `aria-label` to the shared shell.
- [ ] Add one polite arrival announcement; keep countdown updates out of live
      regions.

## Codex checklist

- [ ] Split `kind === "question"` into a shared-card adapter while retaining
      genuinely different MCP form and MCP URL bodies.
- [ ] Wrap surviving MCP branches in the shared amber blocking shell.
- [ ] Pass every Codex interaction's authoritative `expiresAt` into the shared
      deadline behavior.
- [ ] Preserve question and option IDs independently of duplicate labels.
- [ ] Support multi-question navigation and progress.
- [ ] Support provider-allowed multi-select and option-plus-custom-answer
      combinations.
- [ ] Keep multiple identical option labels independently selectable.
- [ ] Leave a concise transcript/history trace when a Codex interaction times
      out or its generation is lost instead of silently removing the card.
- [ ] Never answer an interaction belonging to a dead app-server generation.

## Deadline checklist

- [ ] Use one shared five-minute product constant where Claude/Codex already
      implement that policy.
- [ ] Preserve shorter provider-published Codex `autoResolutionMs` deadlines.
- [ ] Add `requestedAt` and `expiresAt` to authoritative tmux hook snapshots.
- [ ] Show the tmux backend's actual deadline in every applicable hook card.
- [ ] Preserve a documented ten-minute tmux exception if Milestone 1 proves it
      intentional.
- [ ] Omit a countdown for screen-detected terminal selection prompts that have
      no reliable authority-owned deadline.
- [ ] Do not invent an OpenCode client deadline when its protocol publishes
      none.

## Draft, answer, and exception checklist

- [ ] Key non-secret drafts by provider, session, request, and question ID.
- [ ] Preserve non-secret drafts across tab/environment unmount while the
      authoritative request remains pending.
- [ ] Clear drafts only after applied or reconciled terminal resolution.
- [ ] Keep secret input in local component state only; never use the global
      draft store.
- [ ] Tell the user that secret input is lost when leaving the card if needed.
- [ ] Serialize Claude multi-select answers unambiguously, including option
      labels that contain commas.
- [ ] Correct stale callback-mode documentation to name the actual tmux caller.
- [ ] Document the feature planner as an intentional prose-based discovery
      exception.

## Required tests

- [ ] Shared shell: pending, submitting, expired, withdrawn, stale, invalid,
      retryable error, retry, and dismissal.
- [ ] Codex: duplicate labels, multiple questions, multi-select, custom text,
      short deadline, timeout trace, and dead generation.
- [ ] Claude: comma-containing multi-select answer reaches the SDK boundary
      unambiguously.
- [ ] tmux: every hook type displays its authoritative deadline where one
      exists.
- [ ] OpenCode: no fabricated countdown.
- [ ] Drafts: survive unmount for non-secrets, clear after resolution, never
      retain secrets, and do not survive a renderer restart.
- [ ] Accessibility: group name, arrival announcement, keyboard navigation,
      and no live countdown spam.
- [ ] Narrow/mobile viewport with the software keyboard open.

## Manual verification

- [ ] Start a request in environment A and switch to environment B before it
      arrives.
- [ ] Return to A and verify the card, deadline, draft, and controls from the
      authoritative snapshot.
- [ ] Answer once and prove a stale second response cannot apply.
- [ ] Repeat for Claude Native, OpenCode Native, Codex Native, and Claude tmux.
- [ ] Verify iPhone and iPad layouts with multi-question content and custom
      input.

## Commands

```bash
bun test apps/web/src/components/chat --parallel
bun test apps/web/src/components/codex --parallel
bun test apps/web/src/components/claude --parallel
bun test bridges/claude-bridge/src/routes --parallel
bun test bridges/codex-bridge/src/app-server --parallel
bun run --cwd apps/web typecheck
bun run --cwd apps/backend typecheck
```

## Exit criteria

- [ ] All app-owned cards share waiting, submitting, expired, stale,
      withdrawn, and retry presentation.
- [ ] Codex questions have parity with the shared wizard and show their real
      deadline.
- [ ] Tmux deadlines match backend authority.
- [ ] Non-secret drafts recover across inactive-environment remounts; secrets
      never enter shared state.
- [ ] Provider answer fidelity is covered for duplicate labels, multi-select,
      and comma-containing options.
- [ ] Interactive behavior remains provider-correct and no automated policy is
      enabled yet.

## Evidence and decisions

Record:

- final shared-shell API;
- deadline values and documented protocol exceptions;
- before/after screenshots for all providers and narrow viewports;
- accessibility checks;
- answer-fidelity fixture results;
- focused test and typecheck output.

No evidence recorded yet.
