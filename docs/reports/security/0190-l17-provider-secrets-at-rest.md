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

Checked 2026-11-05 against `main` at `e8959f0fd`. Line numbers are those of the branch that closes this report. All tests named are in `apps/backend/` unless the path says otherwise. The recommended option is taken: the risk is recorded in [storage.md, Provider secrets at rest](../../architecture/storage.md#provider-secrets-at-rest), and no keychain or `safeStorage` path was added.

| Item | Outcome | Evidence |
| --- | --- | --- |
| Task 1: choose a storage | Done. Keep 0600 and record it as an accepted risk | `docs/architecture/storage.md`, Provider secrets at rest |
| Problem: the secrets are "readable from the database" and in "a mode 0600 SQLite file" | Wrong, corrected. They live in `config.json` and `config.json.bak.1` to `.5`, which are not database stores. The reasoning for accepting the risk does not depend on the file, so it still holds | `src/core/storage-stores.ts:165`; `src/core/storage-secrets-at-rest.test.ts:199` scans a data directory, snapshots included |
| Fact 1: the database and its WAL and SHM are 0600 on creation and on every open | Gap fixed. Creation was right, but an open only tightened the main file, and SQLite keeps the mode of a companion already on disk. A negative control failed on the unfixed code | `src/core/storage-database.ts:280`, `:331-332`; `src/core/storage-secrets-at-rest.test.ts:79` (both database files), `:96` |
| Fact 2: every backup and other copy holding these secrets is 0600 | Gap fixed. `config.json` and its backups were tightened only by a save, so a wider file stayed wide until the next one. Now every start tightens them. A negative control failed on the unfixed code. Database snapshots were already right and hold none of these fields | `src/core/storage.ts:199`, `src/core/storage-config.ts:326`, `src/core/storage-context.ts:856`; `src/core/storage-secrets-at-rest.test.ts:126`, `:141`, `:237` (every snapshot kind, after E5) |
| Fact 2, other copies | Correct. The staged Anthropic key and an agent-test profile's copies are owner-only. Project clone and push pass the token through the environment, with no file | `src/core/commands-containers.ts:498-503`, `tests/container-data-directory-reach.test.ts:178`; `apps/desktop/electron/agent-platform-selection.test.ts`, `apps/desktop/scripts/dev/profile-io.test.ts:1196`; `docs/architecture/github-cli.md` |
| Fact 3: container agents cannot reach the file | Correct for the file. No bind reaches it. The test runs container creation against a fake `docker`, not a real container. A container is deliberately given the keys its settings allow, which the record says | `src/core/commands-containers.ts:464-466`, `:512-515`, `src/core/project-git-mirror.ts:208-222`; `tests/container-data-directory-reach.test.ts:156` |
| Fact 4: answers to clients redact these fields (M3) | Correct | `src/core/commands-validation.ts:218`, `:242`; `src/core/commands-secret-sweep.test.ts:207`; `packages/protocol/src/controller-settings.test.ts:17` |
| Fact 5: decision 2 in todo 0041 stands | Correct. Unchanged, and the code and architecture doc agree with it | `docs/todo/mcp/0041-control-mcp-voice-surface.md:470`; `src/core/control-mcp-credentials.ts:18`; `docs/architecture/control-mcp.md:65` |
| Context: remote-connection tokens use `safeStorage`, desktop only | Correct | `apps/desktop/electron/runtime-profile.ts:176`, `:291`; `docs/architecture/federation.md:186` |
| Context: the backend runs standalone, with no Electron | Correct | `apps/backend/src/main.ts:139`; `docs/architecture/storage.md`, What stays a file |
| Investigation: the fields are read and written as plain config | Correct. The line numbers had drifted | `src/core/storage-config.ts:386`, `:868` |
| Investigation: the database file is set to 0600 | Correct, but not where these secrets live. The line number had drifted | `src/core/storage-database.ts:331` |
| Con of the chosen option: backups and disk images hold plaintext | Recorded, more exactly. The copies that matter are the backups beside `config.json` and any copy of the data directory made outside the app. A cleared key stays in those backups until five more saves | `docs/architecture/storage.md`; `src/core/storage-secrets-at-rest.test.ts:178` |
| Keychain and `safeStorage` options | Not built, as decided | No change to any storage path |

Nothing is left over, so this report raises no to-do.
