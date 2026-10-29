---
id: 109
title: "Template storage and trust"
phase: 1
plan: "P1.9"
status: in-progress
depends_on: [101, 107]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-109-storage"
pr: ""
updated: 2026-10-29
---

# 109 · Template storage and trust

- **Plan:** [P1.9 Template storage and trust](../composable-graphs.md#p19-template-storage-and-trust)
- **Decisions:** D2, D18
- **Depends on:** [101](101-template-schema.md), [107](107-compiler.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Templates are stored, versioned and trusted in the three scopes of D2, under the per-project ceiling of D18.

## Work

- [x] Add `graph-templates` to `STORE_LAYOUTS` (`storage-stores.ts`): user templates with revision compare-and-swap.
- [x] Load built-ins from code.
- [x] Read project templates from `.orkestrator/graphs/*.graph.json` in the project's checkout, and re-read them when files change.
- [x] Trust records per project as `{path, digest, approvedAt}`. A changed digest is untrusted again.
- [x] Per-project capability ceiling. The default allows every agent capability up to the environment's policy. Push and GitHub writes are outside it (D12).
- [x] Commands in `commands-registry-graphs.ts`: `graph_templates_list`, `graph_template_get`, `graph_template_save`, `graph_template_delete`, `graph_template_duplicate`, `graph_template_compile`, `graph_template_import`, `graph_template_export`, `graph_template_trust`.
- [x] Ceiling commands `graph_capability_ceiling_get` and `graph_capability_ceiling_set`.
- [x] Web wrappers in `apps/web/src/lib/backend/graph-templates.ts` for item 110.
- [x] Project removal deletes the project's trust records and ceiling and stops its watch.

## Tests

- [x] Save conflicts on a stale revision.
- [x] Trust resets when a project template's digest changes.
- [x] The ceiling narrows a template's profiles, and a template asking for push is rejected.
- [x] Command tests for each command.
- [x] A project template edited on disk is re-read through the watch and announced.

## Done when

- [x] Templates can be saved, listed, compiled, imported, exported and trusted through backend commands.

## Notes

**2026-10-29 · Files.** Protocol (browser-safe): `graphs/library.ts` (export
`./graphs/library`: wire shapes, bounds, refs, trust state, canonical export text) and
`graphs/builtin-registry.ts` (re-exported from `library`). Backend: `storage-graph-templates.ts`
(`GraphTemplatesRepository`, area type `GraphTemplatesStorage`, reached as
`storage.graphTemplates`), `graph-project-templates.ts` (reader and watch),
`graph-template-service.ts` (`GraphTemplateService`, on `CommandContext.graphTemplates`, built in
`index.ts`, shut down with the backend), `graph-template-errors.ts`, `commands-registry-graphs.ts`
(`registerGraphTemplateCommands`, called from `createCommandRegistry()`), test support
`graph-template-test-support.ts`. Web: `apps/web/src/lib/backend/graph-templates.ts`. Resource kind
`graph-template` added (ids `user:<id>`, `project:<projectId>`; a hint, re-read
`graph_templates_list`).

**2026-10-29 · Store.** `graph-templates` is an envelope with collections `templates` (one row per
user template id: `{id, revision, template, bytes, createdAt, updatedAt}`) and `projects` (one row
per project id: `{projectId, ceiling?, ceilingRevision, ceilingUpdatedAt?, trust: [{path, digest,
approvedAt}], updatedAt}`). Every write is one `updateStoreRow`; the revision check runs inside the
row's transaction. The template's own `revision` field is the store revision (0 = never saved; save
defaults `expectedRevision` to it; the stored copy gets expected + 1). Bounds
(`GRAPH_LIBRARY_BOUNDS`): 200 user templates, 32 MiB of templates (checked against a cached read just
before the transaction, so a cross-process race can overshoot by one save), 128 trust records per
project (approving prunes records of paths that no longer exist). The ceiling lives here, not in
`config.json`'s `RepositoryConfig`: it is graph-only, keeps its own CAS revision, and the project's
row goes with `removeProject` (`ProjectsRepository.removeProject` →
`deleteGraphProjectSettings`). Nothing is environment-keyed, so environment deletion is unaffected.

**2026-10-29 · Project templates.** Read from `Project.localPath` on the machine that owns the
project (container environments clone from that checkout; a project on another node is answered by
that node's backend, which the web reaches through `machineInvoke`). No local checkout → source
`no-checkout`, no templates. Confined to the checkout (the directory's realpath must stay inside
it; files are `lstat`ed and opened with `O_NOFOLLOW`, regular files only); file names
`^[A-Za-z0-9][A-Za-z0-9._-]*\.graph\.json$` ≤ 128 chars; ≤ 64 files by name, ≤ 1 MiB each, ≤ 16
MiB per project; parsed with `parseGraphTemplate` (strict, duplicate keys refused). Refused files are
listed as `problems` `{path, code, message, errors?}` with codes `invalid-template`, `invalid-name`,
`too-large`, `not-a-file`, `unreadable`, `too-many-files`, `total-too-large`; never file contents.
A scan is reused while the listing and every file's ino/size/mtime/ctime are unchanged. Watching:
one **non-recursive** `fs.watch` per project on the deepest existing of `.orkestrator/graphs`,
`.orkestrator`, the checkout root (so creating the directory is seen), at most 32 projects (least
recently scanned closes first); an event drops the cache and rescans after 250 ms, and a changed
result announces `graph-template`. Teardown never blocks (no recursive watch).

**2026-10-29 · Trust and launch.** Trust state `trusted | untrusted | changed` (`changed` = an
approval exists for another digest). Built-in and user templates are always `trusted`. Approving
needs the digest the user reviewed (`digest-mismatch` otherwise); only a valid file can be approved.
`summary.launchable` = trusted and the compiler's `launchable`. `graph_template_compile` with
`forLaunch: true` (and `GraphTemplateService.compileForLaunch(ref, projectId?)`, for 214) throws
`untrusted` for an untrusted or changed template; without it the response carries `blockedBy`.
Decision: duplicating a project template also needs the reviewed digest (a deliberate copy acts like
an approval of that content, and the project ceiling still caps the copy).

**2026-10-29 · Ceiling (D18).** Stored per project; default `{deny: []}` (`isDefault: true`).
`setCeiling` validates with 106's `graphCapabilityCeilingIssues` (so `git.push`/`github.write` are
refused as outside the ceiling, code `invalid-ceiling`), sorts `deny`, CAS on `ceilingRevision`;
`null` resets. Every compile here passes it to `compile()` together with the enabled providers
(`config.global.enabledAgentPlatforms`, all when empty) and the host
(`defaultCoordinatorHostCapabilities()`, probed once). The environment policy stays 107's
`GRAPH_COMPILE_DEFAULT_ENVIRONMENT` at design time; 214 compiles with the launch environment's
policy. Compile results are cached by template digest + ceiling + providers + host (256 entries).

**2026-10-29 · Commands** (inputs → results, shapes in `@orkestrator/protocol/graphs/library`; refusals
throw `GraphTemplateError` with `code` in `GRAPH_TEMPLATE_ERROR_CODES`: `invalid-request`,
`not-found`, `revision-conflict`, `invalid-template`, `untrusted`, `digest-mismatch`,
`limit`, `invalid-ceiling`; the gateway forwards `code`). `ref` is `{scope: "builtin"|"user", id} |
{scope: "project", projectId, path}`.
- `graph_templates_list {projectId?}` → `{templates: GraphTemplateSummary[], project:
  GraphProjectTemplateSource | null, ceiling}`; summary = `{ref, scope, id, name, description?, engine?,
  revision, digest, readOnly, trust, approvedAt?, launchable, compile: {ok, launchable, errors,
  warnings, infos, pendingAcknowledgements, planDigest, cost: {agentSessions, peakParallelism}},
  updatedAt?}`. Order: built-in, user (by name), project (by path).
- `graph_template_get {ref, projectId?}` → `{summary, template}`.
- `graph_template_save {template, expectedRevision?, projectId?}` → `{summary, template}`; `engine` is
  refused on user templates.
- `graph_template_delete {id, expectedRevision?}` → `{deleted}`.
- `graph_template_duplicate {ref, id?, name?, digest?, projectId?}` → `{summary, template}`: new user
  template, revision 1, id `<id>-copy[-n]`, name `<name> (copy)`, `engine` dropped (D5).
- `graph_template_compile {ref | template, projectId?, includePlan?, forLaunch?}` →
  `{summary | null, ok, launchable, blockedBy?, diagnostics, omittedDiagnostics, cost,
  pendingAcknowledgements, planDigest, plan?, ceiling}`.
- `graph_template_import {text, projectId?}` → `{ok: true, detail, renamedFrom?} | {ok: false,
  errors, omittedErrors}` (101's guard codes; `too_large`, `invalid_json` for duplicate keys); a taken
  id gets `-2`…; `engine` dropped.
- `graph_template_export {ref}` → `{fileName: "<id>.graph.json", text, digest}`; text is canonical
  (sorted keys, two-space indent, trailing newline: `graphTemplateExportText`).
- `graph_template_trust {projectId, path, action: "approve"|"revoke", digest?}` → `{projectId, path,
  trust, digest, approvedAt?, records}`.
- `graph_capability_ceiling_get {projectId}` / `graph_capability_ceiling_set {projectId, ceiling |
  null, expectedRevision?}` → `{projectId, ceiling, isDefault, revision, updatedAt?}`.

Web wrappers (each takes an optional trailing `machine`): `listGraphTemplates`, `getGraphTemplate`,
`saveGraphTemplate`, `deleteGraphTemplate`, `duplicateGraphTemplate`,
`compileGraphTemplateInBackend`, `importGraphTemplate`, `exportGraphTemplate`,
`setGraphTemplateTrust`, `getGraphCapabilityCeiling`, `setGraphCapabilityCeiling`.

**2026-10-29 · Built-ins seam for 108.** `packages/protocol/src/graphs/builtin-registry.ts` holds
`GRAPH_BUILTIN_TEMPLATE_FACTORIES` (empty here); 108 adds one factory per built-in (or spreads its
`builtins/index` list) there. `graphBuiltinTemplates()` returns fresh copies; the backend validates
each, skips (and logs the id of) an invalid or duplicate one, and serves them read-only and
duplicable. Until 108 lands the library lists user and project templates only; the service tests
inject built-ins (`builtins` option).
- 2026-10-29 (coordinator, merge with 108): `GRAPH_BUILTIN_TEMPLATE_FACTORIES` now registers 108's three built-ins. Summaries carry `engineStatus` (`active`/`retired`) for built-ins; a built-in is never `launchable` and `compileForLaunch` refuses it with `engine-template`, since it runs on its own engine (D5); a duplicate runs on the graph runtime. Test: "the shipped built-ins run on their engines: listed, never launched as graphs".

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 · Store, project reader and watch, trust, ceiling, service, commands, web wrappers and tests; complete; awaiting PR.
