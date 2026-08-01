# Milestone 2 — Consistent interactive presentation

Status: Implemented; manual verification pending

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

- [x] Extend the existing blocking shell with consistent title, description,
      authoritative countdown, expired/withdrawn state, inline retryable error,
      and action layout.
- [x] Keep `QuestionCard` as the shared multi-question wizard.
- [x] Standardize applied, stale, invalid, retryable-failure, and withdrawn
      outcomes without letting optimistic UI declare final success.
- [x] Disable submit/dismiss while a provider response is in flight.
- [x] Reconcile after an ambiguous transport error before offering a retry.
- [x] Pass `role="group"` and a useful `aria-label` to the shared shell.
- [x] Add one polite arrival announcement; keep countdown updates out of live
      regions.

## Codex checklist

- [x] Split `kind === "question"` into a shared-card adapter while retaining
      genuinely different MCP form and MCP URL bodies.
- [x] Wrap surviving MCP branches in the shared amber blocking shell.
- [x] Pass every Codex interaction's authoritative `expiresAt` into the shared
      deadline behavior.
- [x] Preserve question and option IDs independently of duplicate labels.
- [x] Support multi-question navigation and progress.
- [x] Support provider-allowed multi-select and option-plus-custom-answer
      combinations.
- [x] Keep multiple identical option labels independently selectable.
- [x] Leave a concise transcript/history trace when a Codex interaction times
      out or its generation is lost instead of silently removing the card.
- [x] Never answer an interaction belonging to a dead app-server generation.

## Deadline checklist

- [x] Use one shared five-minute product constant where Claude/Codex already
      implement that policy.
- [x] Preserve shorter provider-published Codex `autoResolutionMs` deadlines.
- [x] Add `requestedAt` and `expiresAt` to authoritative tmux hook snapshots.
- [x] Show the tmux backend's actual deadline in every applicable hook card.
- [x] Preserve a documented ten-minute tmux exception if Milestone 1 proves it
      intentional.
- [x] Omit a countdown for screen-detected terminal selection prompts that have
      no reliable authority-owned deadline.
- [x] Do not invent an OpenCode client deadline when its protocol publishes
      none.

## Draft, answer, and exception checklist

- [x] Key non-secret drafts by provider, session, request, and question ID.
- [x] Preserve non-secret drafts across tab/environment unmount while the
      authoritative request remains pending.
- [x] Clear drafts only after applied or reconciled terminal resolution.
- [x] Keep secret input in local component state only; never use the global
      draft store.
- [x] Tell the user that secret input is lost when leaving the card if needed.
- [x] Serialize Claude multi-select answers unambiguously, including option
      labels that contain commas.
- [x] Correct stale callback-mode documentation to name the actual tmux caller.
- [x] Document the feature planner as an intentional prose-based discovery
      exception.

## Required tests

- [x] Shared shell: pending, submitting, expired, withdrawn, stale, invalid,
      retryable error, retry, and dismissal.
- [x] Codex: duplicate labels, multiple questions, multi-select, custom text,
      short deadline, timeout trace, and dead generation.
- [x] Claude: comma-containing multi-select answer reaches the SDK boundary
      unambiguously.
- [x] tmux: every hook type displays its authoritative deadline where one
      exists.
- [x] OpenCode: no fabricated countdown.
- [x] Drafts: survive unmount for non-secrets, clear after resolution, never
      retain secrets, and do not survive a renderer restart.
- [x] Accessibility: group name, arrival announcement, keyboard navigation,
      and no live countdown spam.
- [x] Narrow/mobile action wrapping and keyboard-safe scroll containment.

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

- [x] All app-owned cards share waiting, submitting, expired, stale,
      withdrawn, and retry presentation.
- [x] Codex questions have parity with the shared wizard and show their real
      deadline.
- [x] Tmux deadlines match backend authority.
- [x] Non-secret drafts recover across inactive-environment remounts; secrets
      never enter shared state.
- [x] Provider answer fidelity is covered for duplicate labels, multi-select,
      and comma-containing options.
- [x] Interactive behavior remains provider-correct and no automated policy is
      enabled yet.

## Evidence and decisions

Record:

- final shared-shell API;
- deadline values and documented protocol exceptions;
- before/after screenshots for all providers and narrow viewports;
- accessibility checks;
- answer-fidelity fixture results;
- focused test and typecheck output.

### Evidence recorded 2026-07-31

- Shared shell API: `BlockingPromptCard` now owns title, description, metadata,
  authority-published countdown, pending/submitting/expired/withdrawn/stale/
  invalid/retryable-error presentation, inline errors, wrapped actions, group
  naming, and a single stable polite arrival announcement. Countdown text is
  explicitly outside live regions.
- Deadline decision: `AGENT_INTERACTION_DEFAULT_TIMEOUT_MS` is 300,000 ms and
  is used by Claude questions/plans, Codex app-server interactions, and tmux
  hook authority. Milestone 1 found no justification for the old tmux ten-minute
  value, so there is no exception. Provider-shortened Codex deadlines remain
  bounded by `autoResolutionMs`; OpenCode and screen-detected terminal prompts
  receive no invented deadline.
- Recovery: non-secret drafts use provider + session + request identity;
  question-level fields retain provider question IDs. Secret question and MCP
  form values stay in component state and are lost on unmount/restart. Ambiguous
  response transports reconcile against authoritative pending snapshots before
  retry; failed reconciliation locks the card until refresh.
- Answer fidelity: duplicate Codex labels keep separate UI identities, selected
  option plus custom text and multiselect arrays reach Codex intact, and Claude
  multiselect answers cross the SDK boundary as JSON arrays so comma-containing
  labels are lossless.
- Codex recovery trace: timeout, provider-generation loss, and session close add
  concise content-free transcript messages. Dead-generation interactions retire
  locally without responding to the replacement child.
- Automated accessibility/layout checks cover group names, stable arrival
  announcements, keyboard navigation, non-live countdowns, scroll containment,
  and wrapped narrow-width action rows. Live before/after screenshots and the
  cross-environment/provider manual matrix remain pending because this run did
  not launch provider sessions.
- Focused tests:
  - web chat 408 passed; Codex 321 passed; Claude 231 passed; OpenCode 185 passed;
  - Claude bridge routes 187 passed;
  - Codex app-server 678 passed, 11 live tests skipped, 0 failed;
  - Claude tmux UI 159 passed; tmux backend 128 passed;
  - client/store recovery 670 passed; protocol interaction contract 36 passed.
- Typechecks passed for web, backend, Claude bridge, Codex bridge, and protocol.
