# Multi Review panel value

Checked against `main` at `06297124` (2026-10-23).

## Task analysis

Analysed 2026-11-11 against `main` at `498b68766`.

### Tasks

1. **Code items 1 to 3 (overlap metric, corpus, cache-read capture)**: already struck through as done. Status: done.
2. **A Codex driver for the consolidation comparison**: `live --provider codex` drives `codex exec` with the report schema (2026-11-11). The billed rounds are in 7568. Status: done.
3. **Prefix-cache measurement: check the reviewers' working directory**: checked from the code on 2026-11-11: the reviewers of one review share it. The real panel runs are in 7568. Status: done.
5. **What each provider's `cacheReadTokens` means**: Claude measured; Codex, OpenCode, Pi, Cursor and now Grok (2026-11-11) read from the code. Left: compare each provider's counter with its turn count once the 7568 panels (0025 task 3) report. Status: open (depends on 7568, 0025 task 3).

### 1. Code items 1 to 3

**Problem.** None left. The three code items are struck through with evidence.

**Context.** The README says to update or remove an item in the change that finishes it. Struck-through items with evidence are allowed and are how this file records them.

**Investigation.** All still present at HEAD. `consolidationOverlap` is at `apps/backend/src/core/review-fanout-provenance.ts:204` and is stored at `apps/backend/src/core/multi-review-service.ts:4327`, with `build-pipeline-review-fanout.ts:88` importing it for the Consolidation session. `cacheReadTokens` is kept as a running maximum in `refreshReviewerUsage` (`apps/backend/src/core/review-fanout.ts:1563`, max at `:1587`). The nine corpus cases are at `apps/backend/src/core/multi-review-evaluation-corpus.ts:177` to `:525`, and `late-unique` now expects `with-fixes` (`:286`). The only commit touching this code since the check is `b9522a87` (#1176), which is the one that built it.

**Decisions.**

- **What to do with the struck-through items?**
  - **Keep them until the file is finished (recommended).**
    - Pros: the evidence lines name the tests a later reader needs; the file's own convention.
    - Cons: about 30 lines of history in a working document.
  - **Delete them now and rely on `review-preparation.md`.**
    - Pros: a shorter file focused on live work.
    - Cons: the test evidence is not repeated in `architecture/review-preparation.md`, so it would be lost.

### 2. Full versus compact consolidation on more samples, cases and models

**Problem.** #833 shipped the compact envelope on deterministic tests alone. The first live round (Claude `sonnet`, five cases, two samples) found no regression, but it is too small to rule out a small one, and no non-Claude model has consolidated the corpus.

**Split 2026-11-10.** The billed rounds (more samples, the four untested cases, Claude and Codex) are on the manual-test checklist (7568, 0025 task 2). What stayed here was the Codex driver the first decision below recommends; the sample and reopen decisions below are the rules that run follows.

**Done 2026-11-11.** `bun scripts/multi-review-evaluation.ts live --provider codex` runs each consolidation through `codex exec --json --output-schema <file> --output-last-message <file>` (`scripts/multi-review-evaluation-drivers.ts`): ephemeral, read-only sandbox, approvals off, user config and rules ignored, and the session-title runner's tool-free feature profile (`session-title-runners.ts`), on the CLI's default model unless `--model` names one. Answers and `run.json` go under `output/multi-review-evaluation/live/codex/`. Evidence: `apps/backend/src/core/multi-review-evaluation-drivers.test.ts` (against fake Claude and Codex CLIs: the arguments, schema and answer files, usage from the last `turn.completed`, failures without content, and a CLI that ignores SIGTERM or exits without reading its prompt). Before the first call, `live --provider codex` runs a credential-free argument check (`consolidationArgsProblem`): the exact argument list with `--help` in place of the prompt, which the CLI's parser rejects on an unknown or misplaced flag without starting a turn. Run 2026-11-11 against the host's codex-cli 0.162.1 (the pin is 0.167.0) with an empty `CODEX_HOME`: accepted, with and without `--model`. It does not check `--config` values or `--disable` feature names, which the CLI reads only when a turn starts, nor the output shape. No consolidation turn has run on the real Codex CLI: that needs a signed-in Codex home, which this work did not touch; the first billed Codex round in 7568 checks the rest. A relative `--bin` or `CODEX_CLI_PATH`/`CLAUDE_CLI_PATH` is resolved against the script's working directory, since each turn runs in its own temporary directory.

**Context.** Still to do, per the file: at least three samples per prompt, the four untested cases (`clean-panel`, `invalid-and-failed`, `coverage-gaps`, `limit-boundaries`) and one non-Claude model. The "Needs verification" item asks the same question and is answered only for Claude.

**Investigation.** `scripts/multi-review-evaluation.ts` has `prompts`, `score`, `panel` and `live` (dispatch at `:245`). `live` (`:172`) drives only `claude -p` through `claudeConsolidation` (`:138`), accepts 1 to 5 samples and defaults to both variants and model `sonnet`. A non-Claude run therefore means generating prompts with `prompts`, answering by hand and passing them to `score` (`:95`). `invalid-and-failed`, `coverage-gaps` and `limit-boundaries` mostly test acceptance (answers that must be rejected), so a live answer for them measures the model's behaviour at the limits rather than consolidation quality.

**Decisions.**

- **Which non-Claude model, and how?**
  - **Codex through `codex exec` with an output schema, scripted the same way as `live` (recommended).**
    - Pros: the next most common reviewer and consolidator; schema enforcement makes answers comparable; repeatable.
    - Cons: adds a second CLI driver to the script; Codex flags and pinned version need checking against `docs/development/upgrade-agents.md`.
  - **Answer the prompts by hand in a chat and `score` them.**
    - Pros: no script change.
    - Cons: not repeatable, and easy to taint by hand-editing an answer.
- **How many samples, and on which cases?**
  - **Three samples on all nine cases for both variants (recommended).**
    - Pros: meets the file's minimum; the boundary cases still exercise the prompt's rules; 54 calls, under three times the first round's 20.
    - Cons: the acceptance-only cases add little signal about quality.
  - **Five samples on the five quality cases only.**
    - Pros: more statistical weight where quality is actually measured.
    - Cons: leaves four cases never run live.
- **What result would reopen the default?**
  - **Any recall loss, false merge or severity drop in compact that full does not show, in two or more samples (recommended).**
    - Pros: matches the constraint "ship only if recall does not regress"; tolerates one noisy sample.
    - Cons: still small numbers; a rare regression could pass.
  - **Any single regression.**
    - Pros: strictest.
    - Cons: model noise alone would trigger it.

### 3. Prefix-cache measurement on real reviewer panels

**Split 2026-11-10.** The real Claude and Codex panels are on the manual-test checklist (7568, 0025 task 3). What stayed here was the working-directory check the Investigation names, which reads code only.

**Done 2026-11-11: they share one.** Every reviewer of a Multi Review gets its provider from `MultiReviewService.providerInstance` (`apps/backend/src/core/multi-review-service.ts`), keyed by the workflow and the reviewer's platform and connected to the review environment's bridge for that platform. Build Pipeline reviewers get theirs from `provider(pipeline, agent)` (`build-pipeline-review-fanout.ts`), the pipeline environment's bridge. `ProviderCreateSessionOptions` carries no directory, and each bridge runs every session in its one process-wide workspace (`claudeWorkspaceCwd` in the Claude bridge, the app-server child's `cwd` in the Codex bridge, `workingDirectory` in the Pi bridge). So two same-platform reviewers of one review run in the same directory, and the directory alone does not break the Claude hit. Anything else the CLI puts before the prompt (for Claude Code, a snapshot of `git status`) is the same for reviewers that start on an unchanged worktree, which read-only reviewers do not change; that part is an inference, not a measurement.

**Problem.** The stable prompt prefix was meant to make reviewers share prompt-cache reads. On Claude the consolidation measurements suggest it cannot, because Claude Code caches only at message boundaries and each reviewer prompt is a single user message. Real reviewer prompts have never been measured, so whether the prefix saves anything is unknown.

**Context.** The working directory also breaks the hit, because the CLI puts it in context before the prompt. The measurement uses `cacheReadTokens` and `panel`'s `laterCacheReadShareDelta`. The counter is cumulative and includes each reviewer's own tool-loop hits.

**Investigation.** `reviewerPanelSection` (`apps/backend/src/core/multi-review-prompts.ts:59`) is still the only per-reviewer text and is the last section. `laterCacheReadShareDelta` is computed in `summarizePanelValue` (`apps/backend/src/core/multi-review-evaluation.ts:365`, field at `:260`). The Claude bridge passes a `systemPrompt` preset (`bridges/claude-bridge/src/services/session-manager-prompt-query.ts:393`) and no explicit cache control, so moving the shared review instructions into a separately cached block would mean either the system-prompt append or a multi-block user message. Codex's consolidation prefix (about 340 tokens) is below OpenAI's 1,024-token cache minimum, but a real reviewer prompt should be well above it. Whether the reviewers of one review share a working directory needs checking before the run, since a different directory alone defeats the Claude hit.

**Decisions.**

- **Measure first, or restructure the prompt first?**
  - **Measure a real two-reviewer Claude panel and a Codex panel first (recommended).**
    - Pros: tells us whether the problem is real for reviewer prompts before changing a prompt-injection boundary; cheap.
    - Cons: the Claude result may only confirm the expected zero, delaying the fix.
  - **Move the shared instructions into the system-prompt append now.**
    - Pros: likely to realise the saving on Claude straight away.
    - Cons: changes where untrusted package content sits relative to instructions; an unmeasured change to a security-relevant layout.
- **What counts as a measurable saving?**
  - **Report the spread of `laterCacheReadShareDelta` over at least three panels per provider, not a single delta (recommended).**
    - Pros: what the file asks for; absorbs tool-loop noise.
    - Cons: needs several real reviews per provider.
  - **Add per-first-model-call cache capture in every bridge.**
    - Pros: isolates the cross-reviewer prefix hit exactly.
    - Cons: a change in every bridge, which assumption 5 explicitly deferred until the coarse number justifies it.

### 5. What each provider's `cacheReadTokens` means

**Problem.** Comparing cache reads across providers is only fair if each reports the same thing. Claude is measured; Codex, OpenCode, Pi and Cursor are understood from code only, and the file does not mention Grok at all.

**Context.** The code reading is that Claude, Codex and OpenCode report cumulative session totals, while Pi and Cursor report the latest turn. The stored value is the maximum seen (assumption 5), which is exact for totals and a lower bound for latest-turn providers.

**Investigation.** Pi maps `assistantUsage.cacheRead` (`bridges/pi-bridge/src/prompt.ts:727`) and Cursor maps `usage.cacheReadTokens` (`bridges/cursor-bridge/src/prompt.ts:749`). The ACP bridge also reports cache reads (`bridges/acp-bridge/src/usage.ts`, persisted in `acp-persistence.ts`), so Grok reviewers produce a value whose meaning the file did not record.

**Grok, read from the code on 2026-11-11.** Grok's value is its latest turn, like Pi and Cursor. `parseAcpTurnUsage` (`bridges/acp-bridge/src/usage.ts`) reads `cachedReadTokens` (or `cacheReadTokens`, `cache_read_input_tokens`, `cached_read_tokens`) from Grok's vendor `_meta`, `turn_completed` and `response_completed` carriers and from ACP `PromptResponse.usage`. `recordTurnUsage` (`acp-session.ts`) merges the up to three carriers Grok announces for one turn into that turn's usage, sums it across a turn's continued attempts (`accumulateAttemptUsage`), and replaces it at the next turn; only the context occupancy, the window and the cost are session snapshots. So the stored maximum is a lower bound for a multi-turn Grok reviewer, as for Pi and Cursor. Whether Grok's own per-turn figure sums every model call in the turn is Grok's to say and needs a signed-in run; no Grok reviewer is in the 7568 panels, so it stays unmeasured.

**Decisions.**

- **How should the question be closed?**
  - **Answer it from the task 3 panels: compare each provider's counter against its turn count, and add Grok's semantics from `usage.ts` (recommended).**
    - Pros: no extra run; the panels already exercise the counters.
    - Cons: a provider with no reviewer in those panels stays unanswered.
  - **Run a dedicated two-turn probe per provider.**
    - Pros: a direct answer for every provider.
    - Cons: six live setups for a measurement detail.

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
  (`multi-review-prompts.ts`) is the first per-reviewer text in the packaged,
  live-worktree and Build Pipeline reviewer prompts. Only the reviewer's lens
  (and, in the Build Pipeline, the reviewer's own instructions) follow it
  (`reviewerPanelTail`), so the invariant prefix is byte-identical across a
  panel whatever lenses it uses. The section still says position carries no
  priority.
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
  `scripts/multi-review-evaluation.ts` (`prompts`, `score`, `panel`, and
  `live` on the Claude or Codex CLI) is the operator entry point. The durable description is in
  [`review-preparation.md`](../../architecture/review-preparation.md#panel-value-measurements).
- **Reviewer lenses (shipped 2026-10-29).** Built by graphs item 005
  (`plans/graphs/005-reviewer-lenses.md`, decision D19 in
  `plans/composable-graphs.md`), not gated on the measurements here. What
  shipped differs from the deferred idea below: a lens is free text
  (`lens: { label, instruction }` on a reviewer row; label at most 64
  characters, instruction at most 4 KiB), not a shared-protocol enum, and the
  launchers offer editable presets (app setting `reviewLensPresets`, shipping
  Security, Performance, Tests and coverage, API and compatibility,
  Maintainability). Following the cache findings under **Qualification**, the
  lens is the last per-reviewer section, after the panel position, so the
  shared prefix stays byte-identical; the lens does not change what Claude can
  cache today (one user message per reviewer). The reviewer prompt says to
  keep reporting critical issues outside the focus. Consolidation evidence
  carries each reviewer's label as `focus`, plus one paragraph telling the
  consolidator not to drop or downgrade a finding for lying outside a focus;
  a panel without lenses gets the same prompt as before. Overlap counts and
  provenance are unchanged. Lenses are opt-in: with none set, every reviewer
  and consolidation prompt is byte-identical to before. Evidence:
  `review-lens.test.ts`, `multi-review-prompts.test.ts` (byte-identical prefix
  across a panel with different lenses), `review-consolidation-evidence.test.ts`,
  `multi-review-evaluation.test.ts` ("reviewer lenses over the corpus": every
  corpus case with a lens on every reviewer keeps every source ID, names each
  reviewer's focus and still scores its reference perfectly). The durable
  description is in
  [`review-preparation.md`](../../architecture/review-preparation.md#reviewer-lenses).
- **Not built.** There is no panel-preset (Quick, Balanced, Thorough) field.
  That is intended until the measurements below exist.

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
  - The Codex driver for `live` exists since 2026-11-11 (`--provider codex`,
    task 2). The wider billed rounds, on Claude and Codex, are in 7568 (0025
    task 2).
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
  - The reviewers of one review share a working directory (task 3, read
    from the code on 2026-11-11), so the directory does not break the hit
    between them. The real panels are in 7568 (0025 task 3). Pi, Cursor and
    Grok values are latest-turn only.
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
  - Overlap from default two-reviewer panels and panels that record
    `consolidationOverlap` is in 7568 (0025 task 4).
- **Lensed panels.** In 7568 (0025 task 4 for real panels, task 2 for
  `live` consolidation with lens labels).

### Deferred until measured

The product decisions gated on the measurements (presets, adaptive stopping, a
different default panel) are in 7568 (0025 task 6). Lenses shipped on
2026-10-29 (see **Current state**).

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
  fixed corpus. For lenses the deterministic corpus checks hold (lens-free
  prompts are unchanged, and with lenses every source finding reaches
  consolidation and every reference scores perfectly); a live recall run with
  lensed panels is still open under **Qualification**.

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
    totals of the provider's prompt-cache reads. Pi, Cursor and Grok report
    the latest turn's value (Grok's merged over the carriers it announces for
    one turn and summed over that turn's continued attempts).
  - Measured on Claude: the value counts real cross-session prompt-cache hits,
    but only for a byte-identical prefix up to a message boundary.
  - Other providers are not measured.

## Needs verification

- None here. The first real-provider consolidation comparison is recorded
  under **Qualification** (Claude `sonnet`, five cases, two samples); the
  non-Claude comparison is in 7568 (0025 task 2).

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

10. **Task 2: how the Codex driver runs a consolidation.**
    - Choice: `codex exec` with `--output-schema` and `--output-last-message`,
      ephemeral and read-only, user config and rules ignored, the
      session-title runner's disabled-feature list, environment context off,
      in a fresh empty directory per call.
    - Why: it is the recommended option; reusing the title runner's profile
      keeps one tool-free Codex configuration in the repository rather than
      two that could drift. Environment context off keeps the working
      directory out of the prompt, so answers depend on the evidence alone.
    - Pros: repeatable and schema-checked, like the Claude driver.
    - Cons: Codex reports no cost or cache writes, so the Codex scores carry
      token and cache-read counts only. Tested only against a fake CLI here.
11. **Task 3: answered from the code, not a probe run.** The task asks for a
    code check before the panels run, and the provider wiring decides it: one
    bridge per environment and platform, one workspace per bridge. A probe
    would have needed a signed-in panel, which is the 7568 run.
12. **Task 5: Grok recorded as latest-turn, not measured.** Read from
    `usage.ts` and `acp-session.ts`. The comparison against turn counts waits
    for the 7568 panels; the file stays open (blocked) for that reading only.

## Related

- [0027-multi-review-scale-and-cost.md](0027-multi-review-scale-and-cost.md): control-plane
  cost, rollback gates and hierarchical consolidation.
- [`review-preparation.md`](../../architecture/review-preparation.md#fan-out-budgets-and-benchmark):
  consolidation sizes and the reasoning behind the 640 KiB and per-report
  budgets.
- [`review-preparation.md`](../../architecture/review-preparation.md#panel-value-measurements):
  overlap counts, cache reads, the corpus and the evaluation script.
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the billed rounds of task 2, the real panels of task 3, task 4, task 6) moved there on 2026-11-10.

## Replaces

- `docs/improvements/multi-review/README.md` (findings 7–9, phases 3–4)
- `docs/improvements/multi-review/plan/08-report-budgets-and-compact-consolidation.md`
- `docs/improvements/multi-review/plan/09-prompt-prefix-and-launcher-value.md`
- `docs/improvements/multi-review/plan/10-scale-validation-rollout-and-cleanup.md`
  (quality evaluation and cache-hit measurement)
