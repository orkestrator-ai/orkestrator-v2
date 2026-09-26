# 06 — Create, register, edit, and remove projects

Status: Verified — see record.
Index: [CLI commands plan](00-cli-commands-index.md).

## Target behavior

Operators can register a repository, attach or clone a local checkout, explicitly
create a private GitHub repository, edit project metadata, and remove an empty
project registration. Every effect and partial outcome is clear to scripts.

## Owners and starting points

- [Project commands](../../../../apps/backend/src/core/commands-registry-projects.ts).
- [Creation helpers](../../../../apps/backend/src/core/commands-projects.ts).
- [Project storage](../../../../apps/backend/src/core/storage-projects.ts).
- [Creation tests](../../../../apps/backend/src/core/commands-project-creation.test.ts)
  and [project tests](../../../../apps/backend/src/core/commands-projects.test.ts).

## Work

1. Implement `project add` for remote registration and explicit backend-local
   checkout attachment/cloning. Define how an existing checkout supplies its
   origin when the remote is omitted; use backend metadata reads, not the CLI's
   current directory. Reject incompatible path/remote combinations.
2. Implement `project create --path … --github-private` as the explicit existing
   scratch workflow. Help/output must say it initializes Git, creates a private
   GitHub repository, and pushes the initial commit. Do not expose a local-only
   mode until a separate backend initializer exists.
3. Admit the action through step 05 and call existing creation helpers with
   their canonical-path locks, duplicate guards, symlink protections, rollback,
   and credential-redacted command errors. Return stage and created path/remote
   identity on recoverable partial failure without exposing embedded tokens.
4. When GitHub creation times out, keep the outcome uncertain and preserve the
   local recovery state. A replay queries the receipt; it must not call remote
   creation again merely because the project registration was never written.
   Remote verification/adoption needs positive identity evidence.
5. Implement a typed `project update` patch for name, folder, remote metadata,
   and local-path metadata. Validate duplicate paths/remotes and repository
   compatibility at the backend boundary. State explicitly that changing stored
   metadata does not move directories or rewrite `.git/config`.
6. Add project metadata revision checking under the same mutation lock. Old UI
   updates still advance the revision; stale CLI edits conflict. Avoid automatic
   read-modify-write retries that overwrite a concurrent user's choice.
7. Implement `project remove` with a backend-atomic child-environment check and
   removal admission. Prevent a racing environment create from passing after
   removal starts. Reuse coordinator/mail cleanup and report its outcome.
   Refuse nonempty projects; no cascade, checkout deletion, or remote deletion
   in this step. Repeated successful removal returns its original receipt.
8. Keep a project ID stable through edits. Return updated public summaries and
   emit the existing resource changes so connected UI clients rehydrate.

## Verification

Use real local repositories/bare origins to test registration, cloning,
duplicate canonical paths, empty/nonempty/symlink targets, metadata revisions,
and remove-versus-create races. Stub only the remote GitHub command boundary
for success, unavailable auth/tool, ambiguous response, and post-remote failure.
Assert no duplicate remote command on replay and no deletion of user content.

Use the gateway/CLI for one end-to-end fixture registration/update/removal
scenario. Do not use live GitHub creation as routine fixture setup. Any optional
remote qualification needs a separately authorized disposable repository.

## Acceptance and handoff

- [x] Registration, cloning, and remote creation have distinct documented effects.
- [x] Partial creation yields a durable receipt and actionable resource identities.
- [x] Metadata changes preserve project identity and reject stale revisions.
- [x] Removal cannot orphan a concurrently created environment.
- [x] CLI and UI observe the same updated project snapshot.

Keep local-only initialization and cascade removal deferred. Rollback leaves
created repositories intact and preserves enough state for explicit adoption.

## Implementation record

Revision: working tree on `a9337716`, 2026-09-26.

- `project list/get/add/create/update/remove/config` in
  [`actions-projects.ts`](../../../../apps/backend/src/core/public-api/actions-projects.ts).
  `create` requires `--github-private`; partial creation keeps a receipt with
  the created remote (`ProjectCreationStageError`).
- Removal fences the project (`project-removal-fences.json`) and
  `addEnvironment` checks the fence under the environment lock, so a racing
  create cannot attach (`public-api-projects.test.ts`).
- CLI and UI: both read the same storage; a real browser shows the CLI-set PR
  base branch in the open and the reloaded Repository Settings dialog
  (`e2e/agent-testing/cli-ui.spec.ts`).
