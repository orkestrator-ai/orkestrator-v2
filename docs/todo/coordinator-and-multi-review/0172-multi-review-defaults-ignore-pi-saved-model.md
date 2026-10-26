# Multi Review defaults ignore Pi's saved default model

Checked against `main` at `00a0cb82` (2026-10-25). Code items done on
2026-10-26 against `main` at `93018933`; only the live qualification is left.

Found by the live coordinator `status` scenario
([0024](0024-coordinator-live-conformance.md)). A Multi Review whose rows
come from the saved defaults (the Multi Review button, or a coordinator's
`launch_multi_review` without rows) resolves a Pi row with no model saved in
Orkestrator to the first model in Pi's catalogue. A Pi tab with no model
starts on Pi's own saved default instead. On a ChatGPT-backed Pi login those
differ, and the first catalogue model is one the login refuses, so every Pi
reviewer, the preparation turn and the Fix fail at once.

## Current state

- `multiReviewDefaultRows` → `concreteRow`
  (`apps/backend/src/core/coordinator-launch-defaults.ts`) takes the action
  default's model, else the platform settings' model, else `offered[0]` of
  the catalogue. `resolveCatalogModelId` (`packages/protocol/src/model-id.ts`)
  returns nothing for an absent model, so `offered[0]` wins.
- The Pi bridge starts a tab with no explicit model on Pi's saved default,
  then `PI_BRIDGE_DEFAULT_MODEL`, then the catalogue's first model
  (`defaultModelIds` in `bridges/pi-bridge/src/agent-session.ts`; 0054). So a
  Pi worker launched with no model runs, and a Pi Multi Review row does not.
- Seen live on 2026-10-25 (macOS, Pi 1.2.0, host Pi default
  `openai/gpt-6.1-sol` on a ChatGPT `openai` login, no Pi model saved in
  Orkestrator): the coordinator's Multi Review resolved every row to
  `openai/gpt-4` and failed with "The preparation session failed: OpenAI API
  error (400)". In the same run, Pi workers with no model ran on the host
  default and passed. Run `qa-coordinator-2026-10-25T17-01-44-657Z`, profile
  `qa-coordinator-pi-c7b5e0a4` (local, ignored).
- Workaround (until this change ships): save a Pi model in Orkestrator
  settings, or name the rows.
- Fixed in code on 2026-10-26: the Pi catalogue marks the model a tab with no
  model starts on (`sessionDefault`), and Multi Review rows and the launch
  dialogs prefer it over the first model. See Outstanding work.

## Outstanding work

### Code

1. ~~**Resolve an unset Pi row to what a Pi tab would start on.**~~ Done
   2026-10-26 with option (b); see the decisions below.
   - `AgentModel.sessionDefault` (`packages/protocol/src/native-agent.ts`)
     marks the model a new session with no model starts on, and
     `sessionDefaultModel` (`packages/protocol/src/model-id.ts`) picks it, else
     the first entry.
   - The Pi bridge's `/global/models` marks the first of `defaultModelIds({})`
     (Pi's global saved default, then `PI_BRIDGE_DEFAULT_MODEL`) that the
     catalogue offers, on copies of the cached rows (`markSessionDefault` in
     `bridges/pi-bridge/src/models.ts`, wired in `http.ts`). Nothing is marked
     when neither is offered, because a session then starts on the first model.
   - The backend keeps the mark: `fetchAcpNormalizedModelsAtResult`
     (`commands-servers.ts`) and the durable catalogue cache
     (`normalizeAcpModelCatalogEntries` in `storage-shared-core.ts`).
   - `concreteRow` (`coordinator-launch-defaults.ts`) now takes the saved
     model, else `sessionDefaultModel(offered)`. An explicit row, an action
     default and a saved platform model still win; a disconnected mark is
     skipped like any disconnected model.
   - Evidence: `coordinator-launch-defaults.test.ts` ("a Pi row with no saved
     model (0172)", six cases including the live catalogue shape
     `openai/gpt-4` first, `openai/gpt-6.1-sol` marked);
     `bridges/pi-bridge/src/http.test.ts` ("marks the model a session with no
     explicit model starts on (0172)": unmarked with no default, the saved
     default marked, a signed-out default skipped for the fallback);
     `models.test.ts` ("session default mark");
     `pi-model-catalog-seeding.test.ts` (mark kept, non-`true` dropped);
     `storage.test.ts` (mark survives a reopen);
     `packages/protocol/src/model-id.test.ts` ("sessionDefaultModel").
2. ~~Check whether Build Pipeline defaults (`buildPipelineInputWithDefaults`)
   and other `concreteRow` callers have the same gap, and fix them together.~~
   Done 2026-10-26.
   - Backend Build Pipeline: no gap. `buildPipelineConfiguredDefaults` omits an
     unset model and `resolveSelection` (`build-pipeline-service-agents.ts`)
     pins one only for OpenCode and Codex, so a Pi step with no model starts
     its session with none and the bridge picks Pi's saved default, as a tab
     does.
   - Other `concreteRow` callers (`multiReviewInputWithDefaults` for the
     controller and coordinator launches, `multiReviewButtonStart` for
     `launch_multi_review`) all go through `multiReviewDefaultRows`, so item 1
     covers them.
   - The renderer had the same gap: every launch dialog (Multi Review, Build,
     Review, agent launch, restart, Fix prompt, new environment, feature
     build) fell back through `firstModelFor` to the first model. It now uses
     `sessionDefaultModel`, `buildReviewModelCatalog` carries the mark into
     the launch options, and `BuildLaunchDialog`'s unset-step effort lookup
     uses the same row. Evidence: `apps/web/src/lib/agent-launch.test.ts`
     ("falls back to the model a tab with no model starts on…") and
     `review-launch-options.test.ts` ("carries Pi's session-default mark…").
   - Multi Review fixes (2026-10-26, review
     `action-2fe2218d7b7b27f0a6f2e0ea53ae2e58`):
     - P2: the Restart and Fix prompt platform switches and the feature-build
       platform switch picked index 0. They now use `sessionDefaultModel` /
       `firstModelFor`. Evidence: the component tests in
       `MultiReviewRestartDialog.test.tsx`, `MultiReviewFixPromptDialog.test.tsx`
       and `FeatureBuildFields.test.tsx`, plus `e2e/PiLaunchDefaults.spec.ts`
       (all three switches in Chromium at desktop and mobile sizes, submission,
       and a fresh draft after reload). `BuildLaunchDialog.test.tsx` covers both
       unset-step spellings picking the marked model's effort list.
     - P1: a durable Pi catalogue cached before the mark existed would still
       pin the refused first model when no Pi bridge is running. Now a Pi
       catalogue with no connected marked row leaves the backend row `default`
       (`reportsSessionDefault` in `model-id.ts`, used by `concreteRow`), and
       the Pi session starts on Pi's saved default, or on its first model when
       there is none. The cache itself is kept. Evidence:
       `coordinator-launch-defaults.test.ts` ("an unmarked catalogue (a
       pre-upgrade cache) never pins the first model", "a disconnected session
       default leaves the model to the session") and
       `commands-registry-coordinator.test.ts` ("resolves persisted Pi defaults
       with no bridge", marked and unmarked caches with no bridge running).
   - `launchSelectionReport` (Control MCP) reports `model: null` for an unset
     model, meaning "the agent picks its own", which is still true; left as is.

### Qualification

- With no Pi model saved in Orkestrator and a ChatGPT-backed Pi login whose
  first catalogue model is refused, a Multi Review from the saved defaults
  runs. The live `status` scenario on Pi is the check
  (`mise run test:agent:coordinator --credential-source pi --scenario status`).
  **Still owed.** It needs a real ChatGPT-backed Pi login with a saved Pi
  default and billed turns, which this worker cannot run. To close it: on a
  host signed in to Pi through ChatGPT (`openai` provider) with
  `defaultProvider`/`defaultModel` saved in `~/.pi/agent/settings.json` and no
  Pi model saved in Orkestrator, run the command above and check that the
  coordinator's Multi Review rows name the saved default (not `openai/gpt-4`)
  and that the preparation, reviewers and Fix finish. The opt-in
  `ORKESTRATOR_AGENT_TEST_PI_SAVED_DEFAULT=1` adds assertions for the refused
  first-model catalogue shape, an unset Orkestrator Pi model, every persisted
  Multi Review row matching the later marked default, completed reviewers and
  consolidation, and a completed Fix turn. It refreshes the real catalogue;
  it never writes a model preference or substitutes a synthetic catalogue.

## Assumptions and decisions

- **How to resolve an unset row (item 1).** Options: (a) leave the row's model
  `default` and let the session pick; (b) mark the session's starting model in
  the catalogue and prefer it; (c) ask the bridge for its resolved default at
  launch and write it into the row. **Chose (b).**
  - Why: it fixes the backend rows and every renderer launch dialog with one
    shared helper, keeps rows concrete (the dialog, the review records and the
    coordinator's selection report keep naming a real model), and reuses the
    catalogue reads that already happen, so a launch costs no extra bridge
    call.
  - Pros: one source of truth (the bridge's own `defaultModelIds`); any other
    platform whose session default is not its first entry can set the same
    flag; old backends and bridges simply omit it and keep today's behaviour.
  - Cons: the mark is only as fresh as the catalogue read. A durable cache
    written before the user changed Pi's default is stale until the next
    `/global/models` read (a cache with no mark at all, such as one written
    before this change, leaves backend rows to the session instead; see the
    next decision): any catalogue read that
    reaches a running Pi bridge (an environment where a Pi tab or worker has
    run) and the Settings refresh both do one. Within a running bridge the
    mark is recomputed from Pi's settings on every read. (a) would always be current but
    leaves "default" in records and still needs the renderer fix; (c) needs a
    new bridge route and a live bridge at every launch.
- **Which settings the mark reads.** Options: global settings only, or the
  project's `.pi/settings.json` too. **Chose global only** (`defaultModelIds({})`,
  untrusted project). Why: `/global/models` serves no session, and its result
  is cached host-wide and shared by every environment, so a project-specific
  default would leak into other projects. Host sessions do not trust project
  resources by default (`resolveNativeAgentExecutionPolicy`), so this is
  exactly where they start. Con: in a container environment, or with a
  per-environment override that trusts project resources, a project
  `.pi/settings.json` naming its own default makes the tab start there while
  the review row uses the global default. Both are defaults the user saved,
  so the row normally still runs, but it is not the same model.
- **An unmarked Pi catalogue in backend rows (review P1).** Options: (1)
  discard unmarked Pi caches when reading them (what the failed automatic Fix
  started); (2) bump the cache schema; (3) leave a Pi row with no saved match
  `default` when nothing is marked. **Chose (3).** Why: an unmarked Pi
  catalogue means either a pre-upgrade cache or a login with no saved default,
  and in both cases the session's own choice is the right one, so `default` is
  correct at run time without throwing away a cache. (1) and (2) also empty
  the Pi picker on every host that has no saved Pi default and no running Pi
  bridge, and (1) does so on every read, not once. Con: in those cases the
  record and the coordinator's report say `default` rather than a model name.
  The renderer dialogs still fall back to the first row of an unmarked
  catalogue, which they show and the user can change; a mark arrives with the
  next live catalogue read.
- **Ordering versus a flag.** Putting the default first in the catalogue would
  have fixed every `[0]` fallback without a type change, but it reorders the
  picker, and normalizers or stores that sort would silently undo it. An
  explicit flag says what it means and survives sorting.
- **Marking nothing when no preferred id is offered.** A session then starts on
  the first model, which is already every caller's fallback, so a mark would
  add nothing. It also keeps "marked" meaning "a saved or configured default
  chose this".

## Constraints and rationale

- An explicit row, an action default and a saved platform model keep winning;
  this is only about the last fallback.
- Never write the user's `~/.pi` settings, or Orkestrator's, to work around
  it in the product.
- The live suite does not work around it either: it would hide the bug the
  scenario found.

## Open questions

- None yet.

## Related

- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md)
- [0062-pi-chatgpt-login-without-saved-default.md](../agent-engines/0062-pi-chatgpt-login-without-saved-default.md)
  (the same refused first model, for a Pi tab with no saved default at all)
- [0054-agent-test-pi-default-model.md](../cross-cutting/0054-agent-test-pi-default-model.md)

## Replaces

- Nothing; new on 2026-10-25.
