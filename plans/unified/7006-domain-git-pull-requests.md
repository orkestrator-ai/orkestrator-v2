---
id: 7006
title: "Convert git, GitHub, pull requests and changes"
phase: 7
plan: "§12 Phase 7 and Appendix E"
status: done
depends_on: [1008, 1010, 1011]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 7006 · Convert git, GitHub, pull requests and changes

- **Report:** [§12 Phase 7](../../docs/reports/unified-federation.md#12-migration-plan), [Appendix E](../../docs/reports/unified-federation.md#appendix-e-command-surface-by-domain), [§11.4](../../docs/reports/unified-federation.md#114-transition-pre-contract-nodes)
- **Depends on:** [1008](1008-contract-ci-job.md), [1010](1010-pilot-node-mail-and-ticket-sync.md), [1011](1011-contract-policy-and-docs.md)
- **Recommended before the web side:** [3002](3002-lib-backend-client-parameter.md) and [2011](2011-scope-domain-negotiation.md). Until they land, the domain's `lib/backend` file calls the domain client bound to the command scope.
- **Parallel with:** the other Phase 7 domain items, and all of Phases 2-6
- **Size:** L
- **Track:** C (contract)

## Domains

`git`, `pull-requests` (including the changes ledger).

## Current state (verified 2026-11-07)

- 81 registered, 54 web-referenced.
- Capability command: `changes_get_capabilities` (`commands-registry-changes.ts:190`); client cache at `lib/backend/changes.ts:129`.

## Work

Apply the conversion checklist from [1011](1011-contract-policy-and-docs.md)'s "Domain contracts" docs to every command in the domains above:

- [x] Define each domain at version 1 (min 1) in `packages/protocol/src/contract/domains/`.
- [x] `defineCommand` for every command, with:
  - `args` and `result` schemas;
  - `access` (workspace, admin or internal), seeded from [0006](0006-grant-scope-live-evidence.md)'s observed list and today's deny-lists;
  - `read`, checked against `isNodeReadCommand`;
  - `critical` fields, with a one-line reason each in Notes.
- [x] Switch handlers to `register(def, handler)`.
  - Lenient handlers stay tolerant.
  - Strict (`assertOnlyKeys`) handlers become tolerant-with-critical.
  - Hand-written `commands-validation.ts` parsing is replaced by the schema where it is equivalent; keep user-facing error text.
- [x] Fold the domain's capability command (if any) into the domain version. Keep the command registered for pre-contract clients until its register row retires.
- [x] Web side:
  - [x] a domain client in `apps/web/src/lib/node-scope/domains/<domain>.ts`, with a version-1 adapter and a version-0 legacy adapter that keeps today's capability gating;
  - [x] the domain's `lib/backend` functions call it (`changes.ts`, `github-pull-requests.ts`, `files-sessions.ts`, `config-integrations.ts`, and `lib/federation/node-change-projections.ts`);
  - [x] typed results replace `invoke<T>` casts (in every converted function).
- [x] Move the domain's shared types from `apps/backend/src/core/models.ts` and `apps/web/src/types/index.ts` to inferred protocol types where they match (see [7010](7010-converge-models.md)).
- [x] Classify the register rows for these domains: retired, mechanical (adapter), or unaffected. Update `version-compatibility.md`.
- [x] Add a scenario module to [1012](1012-mixed-version-qualification.md)'s script for the domain's main flows.
- [x] Regenerate the manifest and the adapters list; the untyped baseline falls.


## Tests

- [x] Each converted handler passes its existing tests unchanged, apart from tests that asserted rejection of unknown keys, which now assert stripping (or the critical-field refusal).
- [x] A domain-client test for each adapter version against fakes.
- [x] Contract CI stage 2 ([1008](1008-contract-ci-job.md)) accepts every in-window snapshot's arguments.

## Done when

- [x] Every command in these domains is defined, the untyped count for them is zero, and the web uses domain clients for them.

## Notes

### Scope (2026-11-07)

- **65 commands, not 81.** The manifest's `git` (23) and `pull-requests` (42) domains, as 1006 seeded them from Appendix E by name. Appendix E's 81 counts the registering files; the rest of those files' commands are mapped to other domains by name (`watch_coordinator_pull_request`, `sync_project_git` and the coordinator PR commands in `coordinator`, `validate_git_url` in `projects`, the local bridge commands in `commands-registry-pr.ts` in `agent-servers`, 7009) and are converted by those items.
- **GitHub issues are `pull-requests`: confirmed.** 1006 mapped `commands-registry-github.ts` there because `DOMAIN_NAMES` has no `github`; the issues share the Settings credential, `sanitizeGitHubError`, the repository identity and the build pipeline's review flow with the pull request commands, and no other domain fits. Kept.
- Files: `packages/protocol/src/contract/domains/git/` (`schemas.ts`, `commands-changes.ts` 14, `commands-worktree.ts` 9, `commands.ts`, `client.ts`, `index.ts`) and `pull-requests/` (`schemas.ts`, `commands-github.ts` 26, `commands-environment.ts` 16, `commands.ts`, `client.ts`, `index.ts`), 7011's `domain.ts`/`events.ts` unchanged; subpaths `@orkestrator/protocol/contract/domains/{git,pull-requests}`; both clients in `DOMAIN_CLIENTS`; `contract/domains/git-pull-requests.test.ts`. Backend: `commands-registry-{changes,diff-base,github,github-pull-requests,pr,terminal}.ts` (the six git status, diff-stat and worktree-probe commands of `commands-registry-terminal.ts`), `github.ts` (types), `commands-registry-git-pull-requests-contract.test.ts`. Web: `lib/node-scope/domains/{git,pull-requests}.ts` (+ `git-pull-requests.test.ts`), `lib/backend/{changes,github-pull-requests,files-sessions,config-integrations}.ts`, `lib/federation/node-change-projections.ts`, `types/github.ts`. Scenario modules `scripts/mixed-version/scenarios/{git,pull-requests}.ts`.

### Where Effect is used (2026-11-07)

- **Effect Schema** for all 65 definitions and their results. Model records follow 7004's `modelRecord<T>()` (declared fields checked, every other key passed through, typed as the protocol interface). The change results are `kind`-discriminated unions whose `keyof` is only `kind`, so `variantRecord<T>()` (`domains/git/schemas.ts`) is the same thing for unions: a field of any variant may be declared (optional when only some variants have it). `openRecord(fields)` (same file) is the open struct for nested parts with no protocol type of their own, typed as the declared struct without an index signature, so the backend's interfaces are assignable (`StructWithRest`'s own static type has an index signature, which interfaces do not satisfy). The GitHub issue model is closed `Schema.Struct`s, field for field.
- **Deliberately not Effect:** the clients are 7002's `commandApi`/`legacyCommandApi` promise adapters over 1009's `createDomainClient`; the handlers keep their own validation helpers where they carry their own bounds and text.

### Decisions (2026-11-07)

- **Argument schemas declare every key a handler reads.** A key read with `asString`/`asNumber`/`asRequiredBoolean` is typed (same "Expected projectId to be a string" text). A required key the handler checks with its own sentence is typed and carries that sentence as its `message` annotation: the changes identifiers (`resourceKey must be a non-empty string`), the pull request reference ("Expected owner, repo and number to identify a GitHub pull request"), the repository reference, the enumerations (`filter`, `method`, `action`, `event`: "Expected filter to be one of open, mine, review-requested, closed") and the issue status; the handler still checks emptiness, bounds and shape. **Every optional key is `optionalKey(Unknown)`**, even where the handler wants a string: `optionalKey(String)` refuses an explicit `undefined`, which in-process callers send (`pr-auto-merge.ts` passes `expectedHeadSha: headSha` and `autoMergeEnabledAt`) and Electron IPC preserves; `Schema.optional` exports `anyOf [T, null]`, which stage 2's fixtures would then send. Lists of strings and nested records stay `optionalKey(Unknown)` so their indexed messages are unchanged. Pinned by `commands-registry-git-pull-requests-contract.test.ts` (texts, and that a refused argument is still a rejection).
- **Strict handlers made tolerant (29):** the three diff-base commands, `get_environment_uncommitted_paths`, `get_environment_commit_ancestry`, the 18 pull request viewer commands, `generate_review_package`, `verify_review_package`, `set_environment_auto_merge`, `arm_`/`disarm_pr_refresh_after_agent_completion` and `pr_monitor_probe_environment`. **Kept strict on purpose:** the inline review comments (`comments[i]`, `comment`) and the review package's `preparation`: values whose unknown parts the handlers refuse (a comment field GitHub would get wrong, evidence metadata that must not enter the package), not argument keys.
- **Async:** every handler is `async`; each registrar registers with 7002's `ASYNC_HANDLER` (a local `register`/`registerDefined` wrapper), so a refused argument stays a rejection for in-process callers (`commands.get(name)?.(args).catch(...)`).
- **Result schemas** are real: the change resources (`ChangeViewResult`, `ChangesGetFilesResult`, history, diff, refresh, handoff, restore, live detail, tool presentations, thread, capabilities, diagnostics, the legacy payload summary), `EnvironmentDiffStatsSnapshot` and its conditional outcome, the git status list and its conditional digest answer (`GitFileChange`), `DiffBaseBranch`/`DiffBaseCommit`, the uncommitted-path and ancestry probes, `ClientEnvironment` (7003's schema) for `set_environment_diff_base` and `set_environment_auto_merge`, the GitHub issue model, the pull request list/detail/timeline/files/merge/comment/thread/label/member records, `PrMonitorSnapshot` and its conditional outcome, the PR detection, verification and merge results, `ReviewPackageReference` and its verification. Both conditional reads keep the legacy bare shape in the union (a backend answers it without the known-revision arguments). Values a newer backend may extend on model records are `Schema.String`; closed results use literals (`viewedState`, the merge outcomes, the issue `state`/`status`), where a new literal bumps the domain. Top-level result arrays are `Schema.mutable` so the inferred types stay assignable to the mutable model types.
- **`access`:** `workspace` for every command (none is in `isWorkspaceExcludedCommand`; 0006's observed list names none of them), except `admin` for `changes_get_diagnostics` (machine-wide operator counters, no client calls it) and `internal` for `pr_monitor_agent_turn_completed` and `pr_monitor_probe_environment` (the backend's own completion and idle edges; "never by a renderer"). The build pipeline's probes (`get_environment_uncommitted_paths`, `get_environment_commit_ancestry`, `generate_review_package`, `verify_review_package`) stay `workspace`: a leaf's pipeline may be driven through a grant, and nothing enforces `access` until 7012, which may narrow them. **`read`** equals `isNodeReadCommand(name)` (pinned by the protocol test).
- **Critical fields**, per field:
  - `pathIds` on `changes_prepare_restore`: ignored, the restore preview (and its apply) covers every file.
  - `expectedHeadSha` on `merge_environment_pr` and `merge_github_pull_request`: the compare-and-swap guard; ignored, a head pushed after the review merges.
  - `expectedPrUrl`, `autoMergeEnabledAt` on `merge_environment_pr`: guards; ignored, another PR or withdrawn auto-merge options merge.
  - `method`, `deleteBranch` on `merge_environment_pr`, `merge_pr`, `merge_pr_local`: ignored, the merge squashes and deletes the branch (both defaults), which cannot be undone.
  - `comments`, `commitId` on `submit_github_pull_request_review`: ignored, the review posts without its inline comments, or anchors them to whatever the head is now.
  - `expectedHead` on `generate_review_package`: ignored, a package of a newer head is reviewed as this one; `validationPlan`, `additionalLimitations`: ignored, the package drops what reviewers were told to check and what it cannot show.
  - Not critical: `idempotencyKey` and `armedAt` (required in every version), the conditional-read keys (older backends already ignore them and callers read both forms), `refresh`, `includeUncommitted`, `fingerprint` (a read answers less, which the caller sees), `cleanupAfterMerge` (ignored, nothing is deleted: the safe direction), `query`, `display`.
- **Capability command partly folded.** `changes_get_capabilities` gated the Changes surfaces on `change-tracking-v1`. `git` version 1 includes that protocol and its fixed features (`GIT_CHANGE_TRACKING_PROTOCOL`: history, git scopes, operation volume). The answer's `restore`, `strictCheckpoints` and `policyVersion` are the backend's change-tracking policy, which a version cannot say, and the only web reader (`RestoreChangesButton`) needs `restore`, so the command stays in the API, typed, and the client still asks; a backend without the service still answers an error that `getChangeTrackingCapabilities` reads as `null`. Considered answering `restore: false` from the version (no round trip); rejected: it would hide restore on every node that enables it. No other command of these domains was capability-gated.
- **Web:** `git(client)` / `pullRequests(client)` are 7002's `domainApi` over a `lib/backend` client (cached per client). In suites the command scope has no negotiated domains, so every existing web test runs version 0, which is today's call (calls without arguments stay bare through `NO_ARGUMENTS`). `getChangeTrackingCapabilities` and the change functions are `async`, so a thrown `unsupported-version` is a rejection. `node-change-projections.ts` reads through `git(routedBackendClient(portalStore, nodeId))` (7003's helper): a routed call carries no range, so version 0.
- **Shared types (7010 direction):** the GitHub issue model (`GitHubIssue`, `GitHubIssueComment`, `GitHubIssueDetail`, `GitHubIssuesSnapshot`, `GitHubLabel`, `GitHubRepository`, `GitHubUser`) is inferred from the protocol schemas; `apps/backend/src/core/github.ts` and `apps/web/src/types/github.ts` re-export it (the parity test `types/github.test.ts` still holds). The web's `MergePrResult`, `MergeEnvironmentPrResult`, `VerifiedEnvironmentPr` and `GitHubCompletionCommentResult` re-export the protocol types (in the uncommitted `config-integrations.ts` change). `models.ts` and `types/index.ts` hold no git or pull-request types of their own (`PrState` belongs to the environment model, 7003).
- **Register rows:** none of the rows serves `git` or `pull-requests` (no row names a change, diff, git status, PR monitor or GitHub path), so none is retired, mechanical or affected. The conditional snapshot reads' legacy shapes (`get_environment_diff_stats` and `get_pr_monitor_state` without known revisions, `get_git_status`/`get_local_git_status` without `knownDigest`) are permanent tolerant reading, not compatibility code, and the result schemas include them. No row is needed for adapter 0: no in-window release advertises either domain (contract CI rule 4 applies only to advertised versions).
- **Stage 2:** `mise run contract:ci` passes (stage 2 on since 7001): no in-window snapshot has a defined `git` or `pull-requests` command yet, so it compares nothing for these domains until the first release with them is snapshotted.
- **Scenario modules:** `git.ts` (git status bare and conditional with a file written for the scenario, the diff-stat snapshot bare and conditional, the diff-base branches, the change view where change tracking runs) and `pull-requests.ts` (the PR-monitor snapshot bare and conditional, the post-turn recheck armed and that exact arm rolled back, auto-merge turned off and read back on the node). Neither reaches GitHub or pushes: the worker has no PR, auto-merge is only turned off, and the issue and viewer commands are not called. Registered in `SCENARIOS`; not yet run live (`mise run qualify:mixed-versions -- --old-version current --scenarios git,pull-requests` is the control run).
- **Test edits** (outside "unchanged"): the four tests that asserted an unknown key's refusal now assert it is dropped (`commands-registry-github-pull-requests.test.ts` split into "drops unknown argument keys" and the unchanged invalid-ref checks; `commands-registry-pr.test.ts`'s `packageContext` and `commands-io-coverage.test.ts`'s `contents` decode against the definition and check the key is gone; `pr-auto-merge-command.test.ts`'s `extra: 1` now succeeds). `diff-base-override.test.ts` faked the environment as `{ id: "env-1" }`; the command answers `ClientEnvironment`, which tests validate, so the fake is a whole `createEnvironment(...)` record.
- **Repaired two files another commit left unparsable.** 7009's a1b9fd51c committed `commands-registry-pr.ts` with its new imports inside `generate_review_package`'s key list, and c64a67788 committed `config-integrations.ts` with the agent-servers helpers copied into `getAgentModelCatalogCache`'s parameter list and one model-catalogue read calling `invoke` with a promise. Both were put back where the working copy has them, in this item's commits 418132007 (`commands-registry-pr.ts`, with this item's change) and 0a64f9792 (`config-integrations.ts`, from HEAD plus only those two repairs and this item's change; the working copy's uncommitted hunks of 7005, 7008 and 7009 stay out). Tell the orchestrator: the temp-index commits of 7009 are inserting hunks at wrong offsets.
- The working copies of `config-integrations.ts` and `files-sessions.ts` also drop the last `const invoke = clientInvoke(client)` (unused once every agent's calls are converted); that hunk is not in this item's commits, where `invoke` is still used, and lands with whichever agent commits those files last. *(2026-11-07, orchestrator, completeness check: done: that hunk is committed (`8d11d44bb`, among others); neither `config-integrations.ts` nor `files-sessions.ts` has a `clientInvoke(client)` left at HEAD.)*
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07: Defined `git` (23) and `pull-requests` (42) at version 1 with real result schemas, registered every handler with its definition (29 strict handlers tolerant, text unchanged, async rejections kept), both clients with version-1 and version-0 adapters in `DOMAIN_CLIENTS`, the web's `lib/backend` change, GitHub pull request, git status, diff-base, PR-monitor and recheck functions and the node change projections through them, the GitHub issue model and PR result types inferred from the protocol, scenario modules for both domains, manifest, baseline, adapters and schema store regenerated (commit 418132007). Tests: protocol `git-pull-requests.test.ts` 18 pass; backend registrar suites (github, github PRs, PR, terminal, diff-base, worktree probes, auto-merge, public-api changes, coordinator worker changes) 213 pass, broader suites (integration, coverage, io coverage, control, PR monitor, auto-merge, public API PRs and reviews, project home, Control MCP) 383 pass, new contract test 14 pass; web: related suites 1848 pass, federation and sidebar suites pass, `git-pull-requests.test.ts` 4 pass; `tests/unit/mixed-version-qualification.test.ts` passes; `contract:ci` passes. The failures seen in those runs belong to other agents' uncommitted work (`peek_container_agent_bridge`, `get_control_mcp_settings`, `getContainerServerLog`). 
- 2026-11-07: Committed the docs and node change projections (3162e585b; the `version-compatibility.md` bullet had already landed with 7005's a28312428, which committed the working copy) and the `config-integrations.ts` slice with the two repairs (0a64f9792). The manifest at HEAD has no untyped `git` or `pull-requests` command and 65 defined ones. Every box is done; aggregate suite left to review preparation.
- 2026-11-07 (orchestrator, completeness check): noted the `config-integrations.ts`/`files-sessions.ts` working-copy hunk is committed.
- 2026-11-07 (claude-worker, completeness audit): mixed-version modules run live (1012 Work log): git 10/10 everywhere. pull-requests failed PR-L3/PR-C3 in the first control run (scenario bug: the module expected an arm token, but `arm_pr_refresh_after_agent_completion` arms only an open, conflicted pull request and the worker has none, so `null` is correct); fixed in the module, then 8/8 in the control and both v2.36.1 topologies.
