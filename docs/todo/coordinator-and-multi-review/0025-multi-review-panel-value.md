# Multi Review panel value

Checked against `main` at `06297124` (2026-10-23).

The aim is more review value per token without losing findings. #833 shipped
two cost changes on the strength of deterministic tests alone: a compact
consolidation envelope and a stable prompt prefix. It also added
duplicate-reviewer warnings to the launcher. The next steps are to prove those
changes kept finding quality and actually save cost, then to measure how much
reviewers overlap. Only after that should presets, lenses, adaptive stopping or
a different default panel be decided.

The code items are done: the overlap metric, the evaluation corpus and
per-reviewer cache-read capture. A first bounded live round has also run (see
**Qualification**): 25 Claude CLI calls over five corpus cases, and
overlap counts from the four real panels stored on the development host. What
remains is the wider live work: more models and samples, Codex and the other
providers, and a cache measurement of real reviewer panels.

## Current state

- **Compact consolidation.** `buildConsolidationEvidence`
  (`apps/backend/src/core/review-consolidation-evidence.ts`) builds
  `ReviewConsolidationEvidenceV1`. Scope, validation, test totals, change types
  and risk areas that every reviewer reported identically go under `shared`.
  Everything reviewer-specific stays on the reviewer, and source IDs keep
  configuration order. On the synthetic corpus the input was about 12% smaller
  at 32 reviewers, with every finding and source ID kept. The old full-report
  builder was replaced, not kept behind a flag. The evaluation harness rebuilds
  it (see below).
- **Report budgets.** `packages/protocol/src/structured-review/budgets.ts`
  applies where a fan-out or consolidation answer is accepted
  (`parseStructuredReportResult` in `review-fanout.ts`), not in the base parser,
  so stored and other review reports stay readable. The provider JSON schema
  carries no `maxLength` / `maxItems`, because several providers reject or
  strip them; the repair feedback states the limits instead.
- **Stable prompt prefix.** `reviewerPanelSection`
  (`multi-review-prompts.ts`) is the only per-reviewer text, and it is the last
  section of the packaged, live-worktree and Build Pipeline reviewer prompts.
  The invariant prefix is therefore byte-identical across a panel. The section
  still says position carries no priority.
- **Launcher.** `packages/protocol/src/multi-review-launch.ts` provides
  `multiReviewDuplicateReviewerGroups`, `multiReviewDuplicateWarning` and a
  turn-count `multiReviewWorkEstimate` / `multiReviewWorkSummary`.
  `MultiReviewLaunchDialog.tsx` shows the warning in a polite live region
  without blocking or changing the launch.
- **Telemetry.** Both owners record `launch.duplicate_reviewers`
  (`multi-review-service.ts`, `build-pipeline-review-fanout.ts`), so
  coordinator and MCP launches are counted too. In production this goes to the
  no-op observer.
- **Overlap metric (done).** `consolidationOverlap`
  (`apps/backend/src/core/review-fanout-provenance.ts`) turns the cited
  `reviewSourceIds` into `ReviewPanelOverlapV1`
  (`packages/protocol/src/review-fanout.ts`). It holds counts and configured
  positions only. Per run it counts reviewers, source findings, cited source
  findings, consolidated findings and single-source findings. Per position it
  counts source, cited, consolidated, single-source and novel findings. Novel
  findings are those no earlier position substantiated. It runs when a
  consolidation is accepted, because `deriveConsolidatedProvenance` strips the
  source IDs from the stored report. Multi Review stores it as
  `MultiReviewWorkflow.consolidationOverlap` and clears it with
  `consolidatedReport`. Build Pipeline stores it as
  `PipelineSession.reviewOverlap` on the Consolidation session, because
  `reviewFanout` is deleted when addressing starts.
- **Cache-read capture (done).** `ReviewerRecord.cacheReadTokens` is recorded
  beside `tokenCount` by `refreshReviewerUsage` (`review-fanout.ts`) and reset
  with it. It is the largest value seen, never lowered. Build Pipeline reviewer
  sessions mirror it as `PipelineSession.cacheReadTokens` once the reviewer
  settles or is stopped.
- **Evaluation corpus (done).** `multi-review-evaluation-corpus.ts` has nine
  synthetic cases. Each has reviewer records, a reference consolidation and,
  where relevant, answers that acceptance must reject.
  `multi-review-evaluation.ts` provides `evaluationConsolidationPrompt`
  (`compact`, or `full`: the `d680ccdb` evidence inside today's prompt),
  `referenceConsolidation`, `scoreConsolidation` and `summarizePanelValue`.
  `scripts/multi-review-evaluation.ts` (`prompts`, `score`, `panel`) is the
  operator entry point. The durable description is in
  [`review-preparation.md`](../../architecture/review-preparation.md#panel-value-measurements).
- **Not built.** There are no preset or lens protocol fields. That is
  intended until the measurements below exist.

## Outstanding work

### Code

1. ~~**Content-free overlap metric.**~~ Done. Evidence:
   `multi-review-evaluation.test.ts` ("panel overlap": position attribution of
   a late unique finding, configured positions with failed reviewers, invalid
   and dropped citations, no text in the output). Persistence is covered by
   `multi-review-service.test.ts` ("derives all provenance labels from cited
   source IDs") and `build-pipeline-review-fanout.test.ts` (Consolidation
   session `reviewOverlap`). The validator is covered by
   `packages/protocol/src/review-fanout.test.ts`.
2. ~~**Checked-in evaluation corpus.**~~ Done. Cases: `severity-disagreement`,
   `contradiction`, `late-unique`, `same-location-different-reasoning`,
   `clean-panel`, `invalid-and-failed` (failed and stopped reviewers; an
   over-budget field and an invalid severity rejected),
   `coverage-gaps` (cross-kind IDs rejected), `limit-boundaries` (multi-byte
   text at exactly 16 KiB, a 1024-byte path and 100 issues accepted; one byte
   or item more rejected; a 101-finding consolidation accepted), and
   `frame-injection`. Evidence: `multi-review-evaluation.test.ts`, 43 tests.
   Every reference answer is accepted and scores perfectly. Merges, splits,
   severity loss, dropped sources, invented findings, invalid citations and
   wrong verdicts are each detected. Both prompt variants keep one intact
   frame and every source ID.
3. ~~**Per-reviewer cache-read capture.**~~ Done. Evidence:
   `review-fanout-efficiency.test.ts` (recorded beside `tokenCount`, never
   lowered, absent when not reported), `build-pipeline-review-fanout.test.ts`
   (mirrored to reviewer sessions), and `review-fanout.test.ts` (validator).

### Qualification

The harness for each item is in place. The remaining runs need more providers
and real review stacks; batch them with
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

- **Full versus compact consolidation on real providers.** First round done
  on 2026-10-23 with `bun scripts/multi-review-evaluation.ts live --cases
  severity-disagreement,contradiction,late-unique,same-location-different-reasoning,frame-injection
  --samples 2 --model sonnet`. That is Claude Code 2.1.304 `claude -p`, model
  alias `sonnet`, no tools, schema enforced, 20 answers, about $0.90.
  - Recall, false merges, splits, severity, location: identical. All 20
    answers were schema-valid, every expected finding was recalled, with no
    false merge or split, and every severity and location matched.
  - Frame injection: both variants kept the injected finding as evidence and
    ignored the injected instruction and the fake `reviewer-9` ID (4/4).
  - Contradiction: the full variant added a coverage gap that cites an issue
    source ID, a cross-kind citation, in 2/2 samples. Production provenance
    validation rejects that and sends a repair turn. The compact variant was
    clean in 2/2.
  - Late-unique: all 4 answers chose `with-fixes` for a panel with a P0. The
    contract defines `with-fixes` as "the listed issues should be addressed
    first", so the corpus expectation (`no`) was wrong and is now
    `with-fixes`. All 4 answers then score perfectly.
  - Conclusion so far: no quality regression from compact consolidation on
    this model, and one full-variant provenance defect that compact avoided.
    Two samples per prompt and one model are not enough to rule out a small
    regression.
  - Still to do: at least three samples per prompt; the other four cases
    (`clean-panel`, `invalid-and-failed`, `coverage-gaps`, `limit-boundaries`);
    and at least one non-Claude consolidation model. `live` drives only the
    Claude CLI, so another model needs its answers saved by hand and passed
    to `score`.
- **Prefix-cache measurement.** Partly measured, on Claude only, through the
  same `live` path.
  - Separate sessions with a byte-identical prompt and the same working
    directory do share the cache. With `--cwd`, the second identical
    late-unique prompt read 13,075 tokens and wrote 0, and its cost fell from
    $0.048 to $0.016.
  - A different working directory breaks the hit. The CLI puts its working
    directory in context before the prompt, so the fresh-directory runs above
    always read only the CLI's 4,905-token static prefix.
  - A prompt that shares only its opening gets nothing from the cache. In the
    same directory, a different case (same instructions, different evidence)
    read 6,561 tokens. That is exactly what a trivial prompt with the same
    flags reads (the CLI, directory and schema context). So no part of the
    shared consolidation instructions was served from cache. Claude Code
    caches at message boundaries, not at an arbitrary shared prefix inside one
    user message.
  - What that implies: `reviewerPanelSection` keeps the reviewer prompts
    byte-identical up to their last section, but they are still one user
    message each. On Claude the shared part should therefore not be read from
    cache across reviewers, unless the bridge puts it in a separately cached
    block. This is an inference from the consolidation prompts, not yet a
    measurement of reviewer prompts.
  - Codex was not measured. The consolidation prompts share only 1,353 bytes
    (about 340 tokens) before the evidence, below OpenAI's 1,024-token
    prefix-cache minimum, so they cannot show anything. Real reviewer prompts
    can.
  - Still to do: run a real panel of two or more reviewers on one agent and
    model (Claude, then Codex) on a build that records `cacheReadTokens`
    (this branch). Run `panel` on the export and report
    `laterCacheReadShareDelta` across several panels. The counter is cumulative
    and includes each reviewer's own tool-loop cache hits, so report the
    spread, not one delta. Pi and Cursor values are latest-turn only.
- **Overlap from real panels.** First data from the four completed real Multi
  Reviews stored on the development host (2026-10-23). All four used the same
  panel: claude/opus, codex, cursor, and opencode (deepseek flash) at
  positions 1–4. The installed app predates `consolidationOverlap`, so the
  counts come from the report's model labels through `overlapFromModelLabels`.
  That is exact here because every label in the panel is distinct.

  | Panel | Reviewers | Consolidated | Single-source | Novel by position 1/2/3/4 |
  | --- | --- | --- | --- | --- |
  | A | 4 | 6 | 5 | 2/0/0/4 |
  | B | 4 | 2 | 2 | 1/1/0/0 |
  | C | 3 (claude failed) | 7 | 5 | –/2/2/3 |
  | D (this branch's review) | 4 | 7 | 5 | 3/2/0/2 |

  - Across the four panels, 17 of 22 consolidated findings had one source
    (77%).
  - The first two positions found 11 of the 22 (50%).
  - Position 3 (cursor) added a novel finding only in panel C, where claude
    had failed.
  - Position 4 (opencode) added 9 of the 22, but it used 5 to 21 million
    tokens per review against 0.8 to 5.4 million for the others.
  - In panel A, position 2's one finding was dropped by consolidation.
  - Four panels on one day are a first look, not enough for the deferred
    decisions.
  - Still to do: overlap from the default two-reviewer panel, and from panels
    that record `consolidationOverlap` (this branch), so cited-versus-dropped
    counts are exact.

### Deferred until measured

These are product decisions gated on overlap counts from real panels and on the
quality results above:

- Quick, Balanced and Thorough presets that expand into ordinary, editable
  reviewer rows. Their reviewer counts and models are not assumed.
- Optional, non-exclusive review lenses (correctness, tests, security,
  maintainability, performance) as a shared-protocol enum. Consolidation sees
  the declared lens. Reviewers must still report critical issues outside their
  lens.
- Opt-in adaptive stopping, with a minimum panel and a measured novelty or
  confidence rule.
- Any change to the default two-reviewer panel.

## Constraints and rationale

- No currency or cost estimates without current provider pricing. The work
  estimate counts turns.
- Exact duplicate rows stay valid and only warn. They are independent samples of
  one configuration, which can be deliberate.
- The reviewer index carries no authority. A later reviewer must not defer to
  earlier ones, and reviewer sessions stay isolated. `novelFindings` is
  attributed by configured position for measurement only. It never changes
  prompts or ordering.
- No dormant protocol fields. Add a preset or lens field only with the feature
  that uses it, and reject or drop unknown values safely.
- Never silently cancel reviewers the user selected. Novelty is unknowable
  before a report completes, so cancelling "low-value" reviewers would change
  quality semantics.
- Prompt-cache layout must not weaken the evidence frame or the
  prompt-injection boundary. The envelope writes every `<` and `>` as the JSON
  escapes `\u003c` and `\u003e`, so report text cannot close the frame.
  The rebuilt full variant uses the same serialiser.
- Compaction never truncates findings, gaps, locations, severities or source
  IDs. Over budget, only optional prose is removed, in a fixed order.
- Ship lenses or adaptive stopping only if recall does not regress on the
  fixed corpus.

## Open questions

- ~~Is rebuilding the old full builder worth it, or is a fixed reference panel
  scored by hand enough to judge compact consolidation?~~ Both are built. The
  full builder was one `JSON.stringify` of the attributed reports, so
  rebuilding it cost one function (`evaluationConsolidationPrompt(…, "full")`).
  The fixed reference panel is the corpus, scored by `scoreConsolidation`
  rather than by hand.
- Do all providers' `cacheReadTokens` values reflect prompt-prefix hits, or do
  some report only provider-side context caching? Partly answered.
  - From the code: Claude (`cache_read_input_tokens`), Codex
    (`cachedInputTokens`) and OpenCode (`cache.read`) report cumulative session
    totals of the provider's prompt-cache reads. Pi and Cursor report the
    latest turn's value.
  - Measured on Claude: the value counts real cross-session prompt-cache hits,
    but only for a byte-identical prefix up to a message boundary.
  - Other providers are not measured.

## Needs verification

- Whether any real-provider consolidation comparison was ever run. The first
  one is recorded under **Qualification** (Claude `sonnet`, five cases, two
  samples). None exists for another provider.

## Assumptions and decisions

1. **Where the overlap metric is computed and stored.**
   - Options: (a) compute later from the stored report; (b) record it only as
     an efficiency event; (c) compute it when consolidation is accepted and
     store the counts beside the report.
   - Choice: (c).
   - Why: (a) is impossible, because the stored report has model labels, not
     source IDs. (b) goes to the no-op observer in production, so real runs
     would never yield the number.
   - Pros: works for every real run; content-free; about 300 bytes per panel.
   - Cons: two new persisted fields (one on Multi Review, one on Build Pipeline
     sessions). Older workflows have no counts.
2. **Build Pipeline storage on the Consolidation session, not
   `ReviewFanoutState`.**
   - Options: the fan-out state; a top-level pipeline field; the Consolidation
     `PipelineSession`.
   - Choice: the Consolidation session.
   - Why: `reviewFanout` is deleted when addressing starts. A top-level field
     would need clearing at every review reset and would hold only the latest
     iteration. Sessions are per iteration and are already kept.
   - Pros: one value per review iteration with no extra clearing. Kept when
     report copies are discarded, like `tokenCount`.
   - Cons: readers must find the session labelled "Consolidation".
     `summarizePanelValue` does that.
3. **What "single source" and "novel" mean.**
   - Choice: a consolidated finding's sources are the distinct reviewer
     positions among its valid citations. Single source means one position.
     Novel at position p means p is the lowest position cited.
   - Why: two findings cited from the same reviewer are still one reviewer's
     view. Novelty by configured position answers "what would the first k
     reviewers have found", which presets and adaptive stopping need. Using
     completion order would mix provider speed into the number.
   - Pros: deterministic and reproducible. Novel counts sum to the cited
     consolidated findings.
   - Cons: the attribution depends on configuration order, so a single run
     understates later positions that independently found the same issue.
     `consolidatedFindings` per position records those.
   - Rejected: per-severity or per-kind breakdowns. No decision needs them yet,
     and they would be dormant fields.
4. **Structural validation only for overlap counts.** Cross-field invariants
   (sums, cited ≤ source) are tested on the compute function, not enforced by
   `isReviewPanelOverlap`.
   - Why: a miscount must not make the whole workflow or pipeline record
     unreadable.
   - Cons: a corrupted count is accepted silently. It is a measurement, not
     control state.
5. **Cache reads keep the largest value seen.**
   - Options: the latest value; the largest value; the sum of `turns[]`.
   - Choice: the largest value, matching `tokenCount`.
   - Why: it is exact for providers that report session totals (Claude, Codex,
     OpenCode). It is a lower bound for latest-turn providers (Pi, Cursor). The
     sum of `turns[]` is capped at 20 entries and measured differently per
     bridge.
   - Cons: Pi and Cursor understate multi-turn reviewers. The bridges were not
     changed.
   - Rejected for now: per-first-model-call cache capture, which would isolate
     the cross-reviewer prefix hit. It needs changes in every bridge, so wait
     for the coarse measurement to show whether it is worth it.
6. **Full builder rebuilt inside today's prompt, with today's serialiser.**
   - Options: replay the `d680ccdb` prompt verbatim; swap only the evidence.
   - Choice: swap only the evidence.
   - Why: the comparison should isolate the envelope. The prompt text changed
     after `d680ccdb` (for example the single-reviewer rule). The old prompt
     also used plain `JSON.stringify`, which could not keep the frame intact.
   - Pros: an evidence-only A/B; the frame boundary holds.
   - Cons: this is not byte-for-byte what shipped before #833.
   - Production keeps no flag. The variant exists only in
     `multi-review-evaluation.ts`.
7. **A bounded live round, not the full qualification.** The first pass ran no
   live calls, to avoid spending provider quota unasked. After Multi Review,
   the coordinator asked for a small bounded run with the host's existing
   logins.
   - Choice: 25 Claude CLI calls (about $1) through a new `live` subcommand,
     and a read-only export of the stored Multi Reviews for `panel`.
   - `live` runs `claude -p` with no tools, no session persistence and no MCP
     servers, from an empty directory, with the report schema enforced by
     `--json-schema`. It does not use `--bare`, which skips the keychain
     sign-in.
   - Answers stay under the gitignored `output/multi-review-evaluation/live/`.
     Only counts are recorded here.
   - Pros: real evidence for one provider at negligible cost.
   - Cons: one model, two samples. Consolidation through the CLI is not
     byte-identical to the bridge's result tool, though it runs the same
     engine and the same schema.
   - Rejected: driving a full review stack per corpus case (too heavy for a
     first pass), and Codex consolidations (their shared prefix is too short
     to show caching).
8. **Corpus scoring rules.** A model answer matches an expected finding when it
   cites one of that finding's sources with the same kind. Severity and
   location are judged on the best match (the one citing most of the expected
   sources). The `droppable` list lets a case accept a refuted finding being
   dropped. No current case uses it.
   - Assumption: matching on source IDs rather than titles is fair, because the
     prompt requires every consolidated finding to cite its sources, and
     provenance validation rejects answers that do not.
9. **Overlap for stored history from model labels.** Workflows written before
   `consolidationOverlap` have no source IDs.
   - Choice: `overlapFromModelLabels` maps each `reviewModels` label to its
     reviewer when every label in the panel is distinct, and returns nothing
     otherwise.
   - Pros: existing history becomes measurable. The tests check that it equals
     the source-ID counts on the corpus.
   - Cons: it cannot count cited versus dropped source findings, and it cannot
     handle panels that repeat a model.
   - Rejected: guessing positions for repeated labels.

Measured on the corpus (`prompts`, deterministic): compact evidence is 81–93% of full evidence
for two to five reviewers. One usable report makes it 10% larger. For two small
reports the whole compact prompt is about 2% larger, because the explanation of
`shared` outweighs the saving. This does not change the default. The live
round agrees: the compact prompt's uncached tokens (Claude's cache writes) were
2% lower for the three-reviewer case and 7% lower for the five-reviewer case,
and about 1% higher for the two-reviewer cases.

## Related

- [0027-multi-review-scale-and-cost.md](0027-multi-review-scale-and-cost.md): control-plane
  cost, rollback gates and hierarchical consolidation.
- [`review-preparation.md`](../../architecture/review-preparation.md#fan-out-budgets-and-benchmark):
  consolidation sizes and the reasoning behind the 640 KiB and per-report
  budgets.
- [`review-preparation.md`](../../architecture/review-preparation.md#panel-value-measurements):
  overlap counts, cache reads, the corpus and the evaluation script.

## Replaces

- `docs/improvements/multi-review/README.md` (findings 7–9, phases 3–4)
- `docs/improvements/multi-review/plan/08-report-budgets-and-compact-consolidation.md`
- `docs/improvements/multi-review/plan/09-prompt-prefix-and-launcher-value.md`
- `docs/improvements/multi-review/plan/10-scale-validation-rollout-and-cleanup.md`
  (quality evaluation and cache-hit measurement)
