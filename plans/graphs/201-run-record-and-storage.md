---
id: 201
title: "Run record and storage"
phase: 2
plan: "P2.1"
status: in-progress
depends_on: [107]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-201-runs"
pr: ""
updated: 2026-10-29
---

# 201 · Run record and storage

- **Plan:** [P2.1 Run record and storage](../composable-graphs.md#p21-run-record-and-storage)
- **Decisions:** D7, D8
- **Depends on:** [107](107-compiler.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A durable, bounded run record and artifact store that every runtime item reads and writes.

## Work

- [x] `packages/protocol/src/graphs/run.ts`: `GraphRun`, `NodeActivation`, `GraphArtifact` (report §5.4, §8.1).
- [x] Stores `graph-runs` (revision compare-and-swap) and `graph-artifacts` (value artifacts by digest, with lineage).
- [x] Reference artifacts under `.orkestrator/graph-artifacts/<run-id>/`, hash-verified before each consumer, inside containers too (reuse the review package's `sha256sum` path).
- [x] Budgets: 32 MiB inline and 256 MiB on disk per run; bounded activation history; at most 50 rewinds.
- [x] Each activation records the policy and enforcement tier it actually got.
- [x] Environment deletion removes run artifacts (`docs/architecture/environment-deletion.md`).
- [x] Backend validators 103 left: `validation-plan@1` headRef equals the workspace HEAD, and the `review-package@2` hash check, through the workflow-result environment hook.

## Tests

- [x] Compare-and-swap conflicts.
- [x] Every bound refuses overruns explicitly.
- [x] A tampered reference artifact fails verification.
- [x] The container path verifies inside the container.
- [x] Deleting the environment removes its artifacts.

## Done when

- [x] Runs and artifacts persist, reload and stay within their bounds.

## Notes

**2026-10-29 · Files.** Protocol (browser-safe, export `./graphs/run`): `graphs/run.ts` (entry,
re-exports), `run-model.ts` (shapes, statuses, bounds), `run-identity.ts` (keys, paths, digests),
`run-guards.ts` (guards, typed limit violations), `run-lineage.ts` (runtime helpers); tests
`run.test.ts`, fixtures `run-fixtures.test-support.ts`. Backend: `storage-graph-runs.ts`
(`GraphRunsRepository`, area `storage.graphRuns: GraphRunsStorage`), `graph-run-errors.ts`
(`GraphStorageError`), `graph-artifacts.ts` (`GraphArtifactStore`, deletion helpers),
`graph-run-test-support.ts`; tests `storage-graph-runs.test.ts`, `graph-artifacts.test.ts`.
`STORE_LAYOUTS` gains `graph-runs` (record, owner `environmentId`) and `graph-artifacts` (record,
owner `runId`). Docs: `storage.md`, `environment-deletion.md`, `agent-engines.md`.

**2026-10-29 · Run shape (for 202–213).** `GraphRun {format: "orkestrator.graph-run",
formatVersion: 1, id, projectId, environmentId?, template {id, revision, digest, scope?}, plan
(frozen CompiledGraphPlan), bindings {roles: role → GraphModelBinding | GraphModelBinding[],
params, inputs: name → artifact id}, status, mock, activations, rewinds, loopIterations: loop →
iteration, usage {agentSessions, tokens, cacheReadTokens?}, revision, createdAt, updatedAt,
startedAt?, finishedAt?, cancelRequestedAt?, error?, errorCause?}`. `GraphModelBinding {platform,
model?, reasoningEffort?, fastMode?}` (the action-default shape, platform resolved). Statuses
`GRAPH_RUN_STATUSES`: §8.1's plus `waiting` (a person must act: human node or `ask_human`; 208).
`mock: boolean` is 213's flag. `NodeActivation {key, nodeId, iteration, branchKey?, attempt,
state, inputs: port → id | id[], outputs: port → id, session? {agent, model?, effort?,
providerSessionId?, requestId, dispatchState, resultTransport, resultKeys?: port → key,
tokenCount?, cacheReadTokens?, transcript?}, policy?, enforcement?, enforcementReason?, baseline?
{headRef, pathsDigest}, guards? [{guard: read-only|remote-ref|enforcement, outcome:
passed|violated|unavailable, at, detail?, paths?}], error?, errorCause? (GRAPH_ERROR_CAUSES),
createdAt, startedAt?, finishedAt?, supersededBy?}`. States: §8.1's plus `awaiting-human`. The guard
requires `policy` and `enforcement` together, and both once `session` exists (a dispatched
activation always records what it got; 204 writes them, 209 the guard slots). `GraphRewind {id,
kind: restart|rewind-code, nodeId, activation, iteration, requestedAt, requestedBy:
user|coordinator|runtime, superseded {activations, artifacts}, code? {headRef, backupRef?}}`.

**2026-10-29 · Keys and paths.** `graphActivationKey({nodeId, iteration, branchKey?, attempt})` →
`node#iter=<n>[#branch=<key>]#attempt=<n>`, `parseGraphActivationKey` (exact inverse, null
otherwise), `graphActivationSlot` (key without attempt). Branch keys `GRAPH_BRANCH_KEY_PATTERN`
(`panel.2`, `lens.security`, `panel.1+lens.tests`; no `#`/`=`; 205 picks the scheme). Run and
rewind ids `GRAPH_RUN_ID_PATTERN` (`[A-Za-z0-9][A-Za-z0-9_-]{0,127}`). Files:
`graphArtifactFilePath(runId, sha256, ext?)` = `.orkestrator/graph-artifacts/<run>/<sha256>[.ext]`,
`parseGraphArtifactFilePath` refuses anything else (no traversal by construction).

**2026-10-29 · Artifact identity (deviation, recorded).** `digest` = SHA-256 of
`type + "\n" + canonicalJson(payload)` (payload = `{value}` or `{file: {sha256, bytes}, value?}`):
the report's content address. `id` = SHA-256 of canonical `{digest, runId, producer, inputs,
workspace}`, not the digest alone: two activations of one run often produce identical content
(an unchanged `workspace@1` across loop iterations), and a shared id would let a restart of one
supersede the other's output and would lose the second producer's lineage. Ids stay
deterministic and immutable; a retry of the same submission is idempotent.
`verifyGraphArtifactIdentity(artifact, hash?)` re-derives digest, id and bytes. Run inputs use
producer `{nodeId: "$input", activation: "$input", port: <input name>}`
(`GRAPH_RUN_INPUT_PRODUCER`). Reference bodies are `{file: {path, sha256, bytes}, value?}`, `value`
being the type's descriptor (`review-package@2`), validated and held to the value cap.

**2026-10-29 · Bounds** (`GRAPH_RUN_BOUNDS`, `GRAPH_ARTIFACT_BUDGETS`). Live (not superseded)
activations ≤ 200 (the compiler's hard cap); history ≤ 2,000; rewinds ≤ 50; errors ≤ 2,000
chars (`boundGraphError`); guards ≤ 8 per activation; record ≤ 16 MiB serialized; attempt ≤
1,000. Per run: inline ≤ 32 MiB, disk ≤ 256 MiB, ≤ 8,192 artifacts; per artifact: value ≤
384 KiB, file ≤ 32 MiB (and its type's `maxBytes`), lineage ≤ 256, item ids ≤ 10,000. Superseded
artifacts keep counting (invariant 3). Overruns are refused with `GraphStorageError.code` from
`GRAPH_RUN_LIMIT_CODES` (`activations`, `activation-history`, `rewinds`, `record-bytes`,
`error-length`, `inline-budget`, `disk-budget`, `value-bytes`, `reference-bytes`,
`artifact-count`, `artifact-inputs`, `artifact-items`) plus `limit` and `actual`; protocol
`graphRunLimitViolation`, `graphRunRecordBytesViolation`, `graphArtifactLimitViolation` give the
same codes. Other codes: `revision-conflict`, `run-exists`, `run-not-found`, `invalid-run`
(`issues`: path:code), `plan-changed`, `newer-format`, `environment-not-found`,
`environment-deleting`, `invalid-artifact`, `artifact-conflict`, `artifact-not-found`.

**2026-10-29 · Pure helpers (protocol).** `validateGraphRun(value, {verifyPlan?})` (checks the
frozen plan's digest, template match, nodes and loops named exist, keys match parts, unique keys,
superseded ⇔ `supersededBy` naming a rewind), `validateGraphArtifact`, `appendGraphActivation`,
`replaceGraphActivation` (a superseded activation never changes), `liveGraphActivations`,
`liveGraphArtifactsForPort(run, artifacts, {nodeId, port, iteration?, branchKey?})`,
`graphLineageDescendants(run, artifacts, activationKey)` → `{activations, artifacts}` (the
activation, its outputs, consumers of those transitively, and artifacts whose lineage reaches
them; already superseded ones left out), `applyGraphRewind(run, rewind)` (marks, rewinds the
node's loop counter, refuses a 51st, a duplicate id or an already superseded activation),
`graphArtifactFootprint`, `isGraphRunTerminal`, `isGraphActivationTerminal`. All return a new record
or `{ok: false, code, message}`.

**2026-10-29 · Store API** (`storage.graphRuns`). `createGraphRun(run)` (revision 0 in, 1 stored),
`getGraphRun`, `listGraphRuns(environmentId)`, `listGraphRunIds(environmentId)` (raw attribution),
`listAllGraphRuns`, `saveGraphRun(run, expectedRevision, {supersede?: {rewindId, artifactIds}})`
(CAS inside the row's transaction; the plan digest, project and a set environment are fixed; with
`supersede` the artifact marks commit in the same transaction, all or nothing),
`putGraphArtifact` (idempotent for the same envelope, `artifact-conflict` otherwise; budgets in the
insert's transaction via the run's usage row), `getGraphArtifact`, `listGraphArtifacts` (per-run
owner index), `graphArtifactUsage`, `supersedeGraphArtifacts`, `deleteGraphRunsByEnvironment`. Writers
of both stores share one lease (`graph-runs.json`); every write is an `updateStoreRow`; writes
refuse an environment that is missing or marked for deletion. Record-upgrade hook: reads classify
`formatVersion` — newer is refused (`newer-format`, a downgrade fence; never rewritten), a future
shape change adds its one-shot upgrade to `storage-record-upgrades.ts`. No resource-change kind
is announced yet: 211 adds `graph-run` to `RESOURCE_KINDS` with the run view.

**2026-10-29 · Artifact API** (`new GraphArtifactStore({storage, fence, createRunner?, spawn?})`).
`putValue({runId, type, producer, inputs?, workspace?, itemIds?, validation?, value})` and
`putFile({…, contents, extension?, value?})` check the value against its type from the run's frozen
plan (`GraphTypeLibrary(run.plan.types)`, `validateGraphArtifactValue`, storage class must match;
`validation` passes `choices`/`criterionIds`). `putFile` refuses an overrun before writing, makes
`.orkestrator` Git-excluded, writes 0444 without following symlinks (host: `writeConfinedFile`;
container: `CONTAINER_PINNED_ATTACHMENT_WRITE` via `docker exec -i`), re-hashes at the source, then
stores. `verify(runId, id, {allowSuperseded?})` → `{ok, artifact}` or `{ok: false, code}` with codes
`not-found`, `superseded`, `identity`, `no-environment`, `missing`, `not-confined`, `too-large`,
`unavailable`, `size-mismatch`, `hash-mismatch`; `requireVerified` throws
`GraphArtifactVerificationError`. Run `verify` before every consumer (204 renders, 207 seals).
The hash path is `hashEnvironmentWorkspaceFile` (extracted from `verifyValidationArtifacts`,
which now uses it): host stream with confinement checks, container `realpath`/`stat`/`sha256sum`.

**2026-10-29 · Validators bound here.** `WORKFLOW_RESULT_ENVIRONMENT_VALIDATOR_IDS` gains
`validation-plan` (issue `head_mismatch` at `$.headRef` unless it equals `HEAD^{commit}`) and
`review-package-reference` (issue `package_changed` when `verifyEnvironmentReviewPackage` says
invalid). `gitEnvironmentValidator(git, {verifyReviewPackage})`; the backend passes the real
check; without one a review package value is refused (fail closed). `workspace-commit` and
`file-list-paths` stay 103's git-backed checks.

**2026-10-29 · Environment deletion.** Before the container and worktree steps,
`removeEnvironmentGraphArtifactFiles` removes each run's directory (host: `removeConfinedDirectory`;
running container: `CONTAINER_PINNED_ATTACHMENT_REMOVE`; best-effort, counted, logged as a count),
which matters for worktrees deletion keeps (project home). With the other environment-keyed records,
`deleteGraphRunsByEnvironment` removes the runs, their artifact rows and usage rows. A run that
never got an environment (failed provisioning) is not environment-keyed: 214/202 must clean those
up with their launch.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Run record, stores, artifact store with on-disk hash verification (host and container), budgets, 103's remaining validators, environment deletion; tests. · complete; awaiting PR
