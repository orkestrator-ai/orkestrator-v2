# Decide how provider secrets are stored at rest

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Choose a storage for provider secrets**: they are plaintext in a mode 0600 SQLite file. Status: open.

### 1. Choose a storage for provider secrets

**Problem.** `githubToken`, `anthropicApiKey`, `cursorApiKey` and `openCodeZenApiKey` are readable from the database by anything running as the user, and they survive in backups of the data directory.

**Context.** The report says to consider `safeStorage` or libsecret. Remote-connection tokens already use `safeStorage`, in the desktop only (`apps/desktop/electron/runtime-profile.ts`, `docs/architecture/federation.md:186`, `:667`). A settled decision elsewhere keeps Control MCP credentials in plaintext at 0600 ([todo 0041](../../todo/mcp/0041-control-mcp-voice-surface.md), decision 2). The backend also runs standalone, with no Electron to call.

**Investigation.** The fields are read and written as plain config (`apps/backend/src/core/storage-config.ts:359-365`, `:834-840`). The database file is set to 0600 (`apps/backend/src/core/storage-database.ts:284`). Redaction protects the answers to clients (M3), not the file.

**Decisions.**

- **What to do?**
  - **Keep 0600, and record it as an accepted risk (recommended).**
    - Pros: matches decision 2 in todo 0041; container agents cannot reach the file; a same-uid local agent can already read host logins and tokens beside it, so encryption would add little.
    - Cons: backups and disk images hold plaintext secrets.
  - **An OS keychain where one exists (Keychain, libsecret), with 0600 as the fallback.**
    - Pros: keeps secrets out of the database, and out of backups.
    - Cons: the standalone backend has no session keyring on a headless host; on Linux, libsecret offers no per-application separation from a same-uid process; a migration and a second storage path.
  - **Encrypt through the desktop's `safeStorage`, with the key handed to the backend.**
    - Pros: reuses an existing dependency.
    - Cons: the backend stops being able to start alone with its config, and a standalone install gets nothing.

## Related

- [Security report, §5 Low severity](../2-26-10-27-security.md#5-low-severity) (L17)
- [Todo 0041](../../todo/mcp/0041-control-mcp-voice-surface.md), decision 2

## Outcome

Checked 2026-11-05 against `main` at `e8959f0fd`. Review follow-up refreshed this outcome after the validated commit `333f9212688c0bf0a235489a1725a6c67c37e50f`; evidence below uses file and symbol names because line numbers have moved. All tests named are in `apps/backend/` unless the path says otherwise. The recommended option is taken: the risk is recorded in [storage.md, Provider secrets at rest](../../architecture/storage.md#provider-secrets-at-rest), and no keychain or `safeStorage` path was added.

| Item | Outcome | Evidence |
| --- | --- | --- |
| Task 1: choose a storage | Done. Keep 0600 and record it as an accepted risk | `docs/architecture/storage.md`, Provider secrets at rest |
| Problem: the secrets are "readable from the database" and in "a mode 0600 SQLite file" | Wrong, corrected. They live in `config.json` and `config.json.bak.1` to `.5`, which are not database stores. The reasoning for accepting the risk does not depend on the file, so it still holds | `src/core/storage-stores.ts`; `src/core/storage-secrets-at-rest.test.ts` scans a data directory, snapshots included |
| Fact 1: the database and its WAL and SHM are 0600 on creation and on every open | Gap fixed. Creation was right, but an open only tightened the main file, and SQLite keeps the mode of a companion already on disk. A negative control failed on the unfixed code | `src/core/storage-database.ts`; `src/core/storage-secrets-at-rest.test.ts` (both database files) |
| Fact 2: every backup and other copy holding these secrets is 0600 | Gap fixed. `config.json` and its backups were tightened only by a save, so a wider file stayed wide until the next one. Now every start tightens them. A negative control failed on the unfixed code. Database snapshots were already right and hold none of these fields | `src/core/storage.ts`, `src/core/storage-config.ts`, `src/core/storage-context.ts`; `src/core/storage-secrets-at-rest.test.ts` (every snapshot kind, after E5) |
| Fact 2, other copies | Correct. Staged Anthropic keys persist while running, stopped or recovery containers reference their portable-input revision; settings changes do not rewrite those copies. The staged Anthropic key and an agent-test profile's copies are owner-only. Project clone and push pass the token through the environment, with no file | `src/core/commands-containers.ts`, `tests/container-data-directory-reach.test.ts`; `apps/desktop/electron/agent-platform-selection.test.ts`, `apps/desktop/scripts/dev/profile-io.test.ts`; `docs/architecture/github-cli.md` |
| Fact 3: container agents cannot reach the file | Correct for the file. No bind reaches it. The test runs container creation against a fake `docker`, not a real container, including nine legacy agent-home mounts and the Anthropic/Cursor environment routes. A container is deliberately given the keys its settings allow, which the record says | `src/core/commands-containers.ts`, `src/core/project-git-mirror.ts`; `tests/container-data-directory-reach.test.ts` |
| Fact 4: answers to clients redact these fields (M3) | Correct | `src/core/commands-validation.ts`; `src/core/commands-secret-sweep.test.ts`; `packages/protocol/src/controller-settings.test.ts` |
| Fact 5: decision 2 in todo 0041 stands | Correct. Unchanged, and the code and architecture doc agree with it | `docs/todo/mcp/0041-control-mcp-voice-surface.md`; `src/core/control-mcp-credentials.ts`; `docs/architecture/control-mcp.md` |
| Context: remote-connection tokens use `safeStorage`, desktop only | Correct | `apps/desktop/electron/runtime-profile.ts`; `docs/architecture/federation.md` |
| Context: the backend runs standalone, with no Electron | Correct | `apps/backend/src/main.ts`; `docs/architecture/storage.md`, What stays a file |
| Investigation: the fields are read and written as plain config | Correct. The line numbers had drifted | `src/core/storage-config.ts` |
| Investigation: the database file is set to 0600 | Correct, but not where these secrets live. The line number had drifted | `src/core/storage-database.ts` |
| Con of the chosen option: backups and disk images hold plaintext | Recorded, more exactly. The copies that matter are the backups beside `config.json` and any copy of the data directory made outside the app. A cleared key stays in those backups until five more saves | `docs/architecture/storage.md`; `src/core/storage-secrets-at-rest.test.ts` |
| Keychain and `safeStorage` options | Not built, as decided | No change to any storage path |
| Review: interrupted-save files | Fixed. Backend startup tightens matching regular config, backup and recovery atomic remnants to 0600. Retained to avoid deleting another backend's active write; old keys can remain indefinitely, documented in the accepted risk. Symlinks, directories and unrelated files are excluded | `src/core/storage-config.ts`, `restrictConfigFileModes`; `src/core/storage-secrets-at-rest.test.ts`, retained-remnant test |
| Review: companion chmod failure | Covered. An injected EACCES propagates, the newly opened SQLite connection is closed and unusable, an existing connection stays usable, and a subsequent open succeeds | `src/core/storage-secrets-at-rest.test.ts`, companion chmod failure test |
| Review: deletion commit order | Refreshed this report in a new commit after all review repairs, then delete it in the final commit. The validated history is preserved; the final commit's parent contains this outcome | Branch history after `333f9212688c0bf0a235489a1725a6c67c37e50f` |

The recorded full-suite run at the validated commit failed with an object-store batch timeout, SSE probe exit 143, and an unnamed multi-review graph timeout/error. The review package classifies all three as undetermined; these are left for verification, not claimed fixed. Focused repair validation is recorded in the pipeline result.

No implementation task remains in this report; the recorded suite failures still need verifier attribution.
