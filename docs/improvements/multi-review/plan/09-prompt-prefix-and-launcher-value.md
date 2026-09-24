# Step 09 — Prompt prefix and launcher value

Status: 🟨 Implemented on branch; presets and lenses deferred

Depends on: Steps 01 and 08

## Outcome

Move invariant reviewer instructions into a stable prompt prefix and expose the
work implied by the selected panel. Warn about exact duplicate reviewer
configurations without forbidding intentional redundancy. Keep model choice and
review quality under user control.

## Stable prompt construction

The packaged reviewer prompt currently introduces dynamic reviewer numbering
near the beginning, which reduces the stable prefix available to provider prompt
caches. Reorder it into these explicit sections:

1. invariant role, safety, evidence, validation, structured-report, and
   implementation-mode instructions;
2. stable structured output schema/instructions;
3. evidence-frame contract;
4. verified package reference and snapshot identity;
5. dynamic reviewer metadata (panel position, model selection, optional lens);
   and
6. the user request/dynamic evidence tail.

The dynamic section must not alter reviewer authority or suggest that a later
reviewer should defer to earlier reviewers. Reviewer sessions remain isolated;
the index is presentation metadata, not collaboration state.

If a provider supports explicit system/developer prompt segments or cached
content blocks, use that capability behind the shared provider abstraction.
Providers without it receive the same concatenated text. Do not introduce
provider-specific behavior in React.

## Prompt tasks

- [ ] Refactor prompt assembly in `multi-review-prompts.ts` into named pure
  sections with snapshot tests for ordering and framing.
- [ ] Ensure the complete schema is not accidentally duplicated between system
  and user segments.
- [ ] Keep package references and untrusted evidence inside the correct framed
  region; prompt-cache optimization must not weaken injection boundaries.
- [ ] Add instrumentation for fixed-prefix bytes, total bytes, and cache-usage
  capability/outcome where providers expose content-free cache metadata.
- [ ] Confirm preparation, reviewer, consolidation, and fix prompts use the
  correct response instruction; do not over-generalize one cacheable prefix
  across semantically different roles.

## Duplicate detection

Normalize each selection using the same backend model identity used to launch:
platform, model ID, reasoning/thinking effort, speed/config axes, and future
focus lens. Exact duplicates receive a stable warning in the launcher:

> Reviewers 1 and 2 use the same configuration. This may provide an independent
> second sample, but often produces overlapping findings and approximately two
> review turns.

The warning does not block launch. The backend also records a bounded duplicate
count because workflows may start through coordinator/MCP surfaces that bypass
the dialog. It must not reject a request the protocol currently accepts.

Do not claim that two different providers or models are independent, cheaper,
or better. Present configurations factually.

## Work estimate

Show deterministic expected work, not a currency forecast:

- reviewer turns: selected reviewer count;
- preparation turns: normally one;
- consolidation turns: normally one;
- possible structured-output repair turns: “up to policy limit”;
- validation: shared once across reviewers; and
- optional fix stage: separate and not included until launched.

If token estimates become available from Step 01, show a broad measured range
with its fixture/date and label it an estimate. Do not calculate cost without
current provider pricing, cache behavior, and account-specific terms.

## Presets and lenses

Add presets only after baseline and quality data identifies defensible choices.
A possible progression is Quick/Balanced/Thorough, but the plan does not assume
their reviewer counts or models. Presets expand into ordinary explicit reviewer
selections and remain editable.

Optional reviewer lenses (correctness, tests, security, maintainability,
performance) require a separate quality experiment. If added:

- lens is an optional shared-protocol enum;
- unknown/legacy values are rejected or omitted safely;
- the base review contract still requires reporting critical issues outside the
  lens; and
- consolidation sees the declared lens for interpretation and provenance.

Do not automatically cancel “low novelty” reviewers. Novelty cannot be known
reliably before their completed report and adaptive cancellation would change
quality semantics.

## UI and protocol tasks

- [ ] Add a pure normalized-configuration comparer shared by validation/tests;
  avoid display-label comparison.
- [ ] Update `MultiReviewLaunchDialog.tsx` to render duplicate warnings and work
  summary accessibly near the reviewer list and confirmation action.
- [ ] Ensure keyboard/screen-reader announcements do not repeat on every render.
- [ ] Apply the same backend-side normalization to coordinator/MCP starts and
  expose warnings in the resulting workflow projection if useful.
- [ ] Preserve the existing default panel until the rollout data justifies a
  change through a separate product decision.
- [ ] If presets/lenses are deferred, document the evidence needed to activate
  them rather than leaving dormant protocol fields.

## Tests and evaluation

- Prompt snapshots prove invariant text precedes dynamic reviewer/index/request
  content and evidence frames remain well formed.
- Exact duplicates across normalized aliases are detected; differences in any
  behavior-affecting axis are not called exact duplicates.
- Launch remains enabled after a warning and launched selections are unchanged.
- Work counts cover retries/repairs honestly and do not present currency.
- Component/browser tests cover two, many, and max reviewers, keyboard focus,
  narrow layout, and screen-reader text.
- Provider evaluation compares cache-hit/input-token metadata before and after
  on repeated identical prefixes without logging prompt content.
- Quality evaluation confirms reordering alone does not change the structured
  report contract or finding quality beyond the agreed variance.

## Acceptance criteria

- The largest safe invariant prompt section is byte-identical across reviewers
  using the same contract.
- Dynamic reviewer numbering no longer breaks the initial prefix.
- Duplicate configurations produce a clear non-blocking warning in all launch
  paths where warnings can be surfaced.
- Users see reviewer/phase work, with no unsupported cost claim.
- Defaults and reviewer authority remain unchanged unless separately approved.

## Implementation record

- Prompts (`multi-review-prompts.ts`): `reviewerPanelSection` is the only
  per-reviewer text. It is now the last section of the packaged reviewer, the
  live-worktree reviewer and the Build Pipeline reviewer prompts, so the
  invariant contract, instructions, schema guide and package reference form a
  byte-identical prefix across a panel. The section still says the position
  carries no priority and forbids deferring to other reviewers.
- `packages/protocol/src/multi-review-launch.ts` (new export
  `@orkestrator/protocol/multi-review-launch`) adds:
  - normalized launch identity (platform, trimmed model, effort, speed,
    unpinned);
  - duplicate groups and count;
  - the factual warning text;
  - a deterministic work estimate and summary (turns, never currency).
- Launcher (`MultiReviewLaunchDialog.tsx`): a polite live region under the
  reviewer grid shows duplicate warnings without blocking or altering the
  launch; a work summary sits above the actions. Both texts change only when
  their content changes.
- Backend: both owners record `launch.duplicate_reviewers` on start, covering
  coordinator/MCP launches that bypass the dialog. Duplicates remain valid.
- Tests: prefix identity across reviewers (`multi-review-prompts.test.ts`);
  duplicate detection, warnings and work summary
  (`multi-review-launch.test.ts`); launcher warning, non-blocking launch,
  clearing on a speed change, turn counts (`MultiReviewLaunchDialog.test.tsx`).
- ⏸ Presets and review lenses: deferred, as the plan allows. Activating them
  needs a fixed benchmark corpus with real-provider finding recall per
  configuration, and cross-reviewer overlap measured from consolidated
  provenance. No dormant protocol fields were added.
- Not measured: provider cache-hit metadata, which requires real providers.
