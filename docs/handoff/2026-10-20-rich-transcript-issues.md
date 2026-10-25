# Rich transcript issues found but not fixed (2026-10-20)

Issues found while implementing and qualifying rich transcripts and
transcript artifacts (`docs/temp/rich-transcripts.md`) on branch
`20261020-005611-6ba26bffea80` (base `67a6cc31`), that were left unfixed. None
blocks the specification's definition of done. Each entry says what was
observed, how sure we are, where to look and a suggested next step.

The remaining tracked work items are in
[todo/transcripts-and-observation/0053-rich-transcripts.md](../todo/transcripts-and-observation/0053-rich-transcripts.md). Artifact cards in
Multi Review, build-pipeline and feature-planning transcripts are covered in
[rich-transcripts.md](../architecture/rich-transcripts.md#workflow-transcripts).

## Product bugs

### 1. Pi gives no reply and no error with a retired default model

- **Observed:** in an isolated `dev:test` profile signed in to Pi through
  OpenAI, a Pi session started without `--model` used the first catalogue
  entry, `openai/gpt-4`. The turn finished ("Agent finished") with no
  assistant message and no error. The same prompt with `openai/gpt-6.1-sol`
  answered normally.
- **Confidence:** reproduced twice (a one-line prompt and the live artifact
  spec). Not caused by this branch; the Pi bridge and model selection are
  unchanged here.
- **Where:** Pi's default model choice (`agent options` reports
  `defaultModel: null` and the composer falls back to the first catalogue
  model), and how the Pi bridge reports a provider-side failure.
- **Next step:** surface the provider error as a failed turn rather than an
  empty success, and pick a default that is known to be current (the
  provider's own default or the most recent model) rather than the first
  catalogue entry.

### 2. The artifact card mounts twice just after publication

- **Observed:** in live runs the published card was removed and drawn again
  once shortly after it first appeared, so a test that found it and then
  scrolled to it hit "Element is not attached to the DOM". The live spec now
  retries that scroll.
- **Confidence:** the re-mount is confirmed; the cause is a hypothesis. The
  client merge (`apps/web/src/lib/chat/artifact-publication-merge.ts`) places
  the publication first, then the backend projection overlay
  (`apps/backend/src/core/native-agent-service-projection-artifacts.ts`)
  places the same part in the row holding the call, and the row is rebuilt.
- **Where:** row identity and keys for a row whose parts change from
  "client-placed artifact" to "backend-placed artifact"; Virtuoso item keys in
  `VirtualizedMessageList.tsx`.
- **Next step:** confirm with a render trace; keep the artifact part's React
  key stable (`artifact:<publicationId>`) whichever side placed it, and avoid
  rebuilding the row when only the source of placement changes. Users may see
  a brief flicker today.

### 3. "Orkestrator has been updated" with the Electron version

- **Observed:** in a browser signed in to a `dev:test` profile the version
  reminder said "This page is Orkestrator 2.23.0, but the server now runs
  44.7.0"; 44.7.0 is the Electron version.
- **Confidence:** observed in every profile run; not investigated. This
  branch does not change version reporting (`apps/web/src/lib/version-reminder.ts`,
  `BackendVersionReminder.tsx`). Assumed to be a development-only quirk
  (an unpackaged Electron reporting its own version), but packaged builds were
  not checked.
- **Next step:** check what the gateway reports as the backend version in an
  unpackaged Electron run and in a packaged build.

## Test infrastructure

### 4. Agent mail same-millisecond ordering (flaky test 0504)

- **Observed:** `StorageService agent mail conversations > joins both
  directions of a pair, oldest first, and lists each pair once` failed in two
  full suites and 1 of 5 isolated reruns.
- **Confidence:** pre-existing; the test and agent-mail modules are unchanged
  on this branch. Recorded in
  [0504](../tests/flaky-tests/coordinator-and-multi-review/0504-agent-mail-conversation-same-millisecond-order.md).
- **Next step:** a deterministic tie-break (insertion sequence) or a test
  clock; two messages sent in one millisecond currently order by a random id
  suffix.

### 5. Rich-content tests interfere when run in one process

- **Observed:** `apps/web/src/components/chat/rich/rich-render-isolation.test.tsx`
  leaves the shared highlight queue stuck because its test backend never
  settles or aborts; `CodeBlock.test.tsx` and
  `apps/web/src/lib/chat/rich-render-priority.test.tsx` then time out when
  they run after it in the same process.
- **Confidence:** reported by two separate workstreams; `--parallel` runs and
  `mise run test` pass. These are tests added on this branch.
- **Next step:** settle or abort the pending job in that test's teardown, or
  reset the highlight scheduler between tests.

### 6. Unconfirmed single-process failures in other suites

- **Observed:** running many files in one process without `--parallel`
  reported about 123 failures in `apps/web/src/hooks` (slash commands,
  sessions, scroll state) and failures in Codex bridge app-server runtime tests
  (refused cells, account reload, session lifecycle).
- **Confidence:** low. The same files pass alone and in the repository's
  parallel runs, and they look unrelated to this branch; not investigated.
- **Next step:** reproduce on the base commit before assuming a cause.

## Known limits of the new features

### 7. Performance under CPU throttling

- Under a 4× CPU throttle the composer median regresses 13–20% against the
  base while a highlighted code fence streams (p95 and scroll frames stay
  within 10%; the unthrottled gate passes). Tracked as a Medium item in
  [todo/transcripts-and-observation/0053-rich-transcripts.md](../todo/transcripts-and-observation/0053-rich-transcripts.md); evidence in
  [rich-transcripts.md](../architecture/rich-transcripts.md#performance-gate).

### 8. Publication placement

- Unanchored publications (no matching call) appear only in the native agent
  tab; other readers of the projection show anchored ones only.
- A publication whose row is in history the backend no longer holds (not in
  the previous view or the row cache) is not pushed as a revised row; readers
  see it when they next page that row.
- When the anchored call is outside the rows a read holds, argument matching
  can place a publication on a repeated call with the same arguments; the
  client removes the duplicate.

### 9. Conversation clearing relies on an inference

- The client treats a ledger that showed publications and now reads empty as
  a deleted conversation. That is correct only while publications are never
  removed individually. An explicit `deleted` flag on the
  `transcript-artifact` change hint, or `not_found` from the list commands
  for a deleted conversation, would make it explicit.

### 10. Media streaming

- Markdown media (`MediaBlock.tsx`) renders only images, so it has no
  audio/video streaming path; large images and media whose bytes come from
  tool output (`detailRef`) do not stream.
- A streamed file over 8 MiB has no Download original action.
- A desktop app connected to a remote backend falls back to the base64 path
  only after the media element errors.
- Staged container copies of a deleted environment are removed by a sweep
  within a minute rather than immediately (their URLs stop working at once).

### 11. PDF

- The existing file readers cap binary reads at 10 MiB, so PDF attachments of
  10–20 MiB get metadata, not a first-page preview.
- No paper-size picker in the UI (A4 or Letter is chosen from the reader's
  region) and no client-side cancel for a running PDF job.
- Printed page counts come from scanning Chromium's PDF output.

### 12. Codex history reload

- When a rollout lacks the recorded `McpToolCall` item, the fallback parses
  only strict-JSON arguments; real Codex cells usually pass JavaScript object
  literals, which it rejects by design (every recent rollout checked had the
  recorded item).
- Other recorded item types (command executions, file changes) and sub-agent
  rollouts are still not rebuilt from records.

### 13. Desktop and browser hosts

- Electron was qualified on the development build (Electron 44.7.0), not a
  signed packaged app; `e2e/agent-testing/artifact-host-electron.spec.ts`
  drives the host API directly and does not click a seeded Run interactive
  button.
- A backend without the viewer shell (`shellUrl`) makes the browser live view
  show an error instead of running.
- With a loopback port wildcard in `ORKESTRATOR_ARTIFACT_FRAME_ANCESTORS` the
  shell posts to its parent with `"*"`; still safe because `frame-ancestors`
  has already checked the parent, but exact origins are preferred.

### 14. Preview worker image

- Publishing the worker image to a registry and pinning packaged installs by
  digest is left to the maintainer:
  `docker/artifact-preview-worker/publish.sh <repository> [tag]` records the
  digest in `published-image.json`, which still holds `null`.

### 15. Mermaid math

- Math labels still render as a `math_labels_unsupported` diagnostic: pinned
  Mermaid 12.2.0 renders math only through `foreignObject` HTML labels with
  fixed KaTeX options, which the sanitizer policy does not allow.

## Found during live QA of workflow artifact cards

Multi Review, build-pipeline and feature-planning artifact cards passed on the
real stack with Codex `gpt-6.1-sol` (publish succeeded, card resolved beside
its call, survived a reload). These issues came up on the way.

### 16. Reviewers may decline to publish

- **Observed:** a packaged (read-only) Multi Review reviewer first refused to
  publish, calling it "outside this turn's constraints". It published once the
  review instruction said the artifact tools write only to Orkestrator's
  transcript store.
- **Confidence:** observed once with Codex; depends on model and wording.
- **Where:** the reviewer prompt presents the user's instruction as a
  preference under a read-only constraint and does not mention the artifact
  tools (`multi-review-service.ts`, `review-fanout.ts` prompt assembly).
- **Next step:** state in the workflow prompts that the artifact tools are
  allowed in read-only turns because they never touch the repository.

### 17. A rejected model shows as "Codex did not receive the prompt"

- **Observed:** the first feature-planning turn failed with "Codex did not
  receive the prompt". The real cause was Codex rejecting the default model
  `gpt-5.4` for a ChatGPT sign-in (HTTP 400). Changing the environment's model
  did not help, because that applies only to new sessions; setting the
  project's Codex model and starting a new plan did.
- **Confidence:** reproduced once; pre-existing, not caused by this branch.
  Same family as item 1 (a default model the account cannot use).
- **Next step:** report the provider's rejection as the error, and let a
  planning retry pick up a changed model.

### 18. "Responded in" label sits under the card in planning chats

- **Observed:** in a feature-planning chat the "responded in 18s" label
  appears under the artifact card instead of under the reply.
- **Cause:** existing chat behaviour puts the label on the first assistant row
  after a user message, which is now the card row.
- **Next step:** skip artifact rows when choosing the row that carries the
  response-time label.

### 19. Live QA needs freshly built bridges

- `dev:test` runs the backend from source but the bridges from
  `bridges/*/dist`. Bridges built before this branch have no
  `orkestrator-artifacts` server, so workflow agents report the artifact tools
  as unavailable. Run `mise run build:<name>-bridge` for each bridge (or the
  combined build) before real-stack QA of workflow artifacts.

### 20. Restarting a `--fixture` profile breaks existing environments

- Restarting a `dev:test --fixture` profile re-seeds the test project, which
  leaves environments created before the restart with broken git worktrees.
  Create new environments after a restart, or reset the profile. Development
  tooling only.

### 21. Not yet qualified live for workflow artifacts

- Only Codex was run on the three workflow surfaces. Claude, Cursor, Grok, Pi
  and OpenCode, fan-out reviewers and consolidation inside a pipeline,
  story-level planning chats, and narrow viewports were not exercised live
  (they are covered by unit and integration tests).
- The build-pipeline run's Build and Verify stages published distinct
  publications (`get_build_pipeline` patches placed a different publication id
  in each stage's message); the publication id shown by each on-screen card
  was not captured directly.
