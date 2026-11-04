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
