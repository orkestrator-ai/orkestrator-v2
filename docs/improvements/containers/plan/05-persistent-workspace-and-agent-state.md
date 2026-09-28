# 05 — Persistent workspace and agent state

Status: Implemented on branch; awaiting review. Dependencies:
[02](02-lifecycle-authority-and-durable-operations.md),
[03](03-image-contracts-and-daemon-preflight.md),
[04](04-runtime-readiness-and-graceful-shutdown.md).
Return to [index](00-index.md).

## Goal

Create new environments with explicit durable workspace/session storage, while
keeping credentials, image tooling and transient runtime state separate. This
step does not migrate or destroy legacy containers; step 06 owns that transition.

## Integration points

- [Container creation](../../../../apps/backend/src/core/commands-containers.ts),
  [backend models](../../../../apps/backend/src/core/models.ts),
  [environment storage](../../../../apps/backend/src/core/storage-projects.ts).
- [Entrypoint](../../../../docker/entrypoint.sh),
  [workspace setup](../../../../docker/workspace-setup.sh),
  [runtime environment helper](../../../../docker/runtime-env.sh).
- [Native session storage](../../../../apps/backend/src/core/storage-native.ts),
  [native-agent reconciliation](../../../../apps/backend/src/core/native-agent-service-reconciliation.ts)
  and each bridge's configured session/history paths.

## Storage contract

| Role | Retention | Mount/layout decision |
| --- | --- | --- |
| Workspace | Until explicit reset/delete | Dedicated named volume at `/workspace`; includes Git database, ignored and untracked files |
| Selected provider session state | Until explicit session/environment deletion | Separate named state volume or role volumes, mounted only at verified provider state paths |
| Portable config inputs | Regenerable, selected by policy | Private staging owned by step 08; no whole host homes |
| Imported credentials | Refreshable/revocable | Dedicated ephemeral/private input paths, excluded from selected session archives |
| Runtime state | Per boot/generation | Ready records, PIDs, bridge tokens and transient sockets; never reused as proof of readiness |
| Disposable caches | Re-creatable | Remain per environment initially; no cross-environment writable cache sharing |
| System tooling | Image/setup-owned | No full-home or root-filesystem volume |

User-authored secrets may exist in the workspace, transcripts or databases.
“Credentials excluded” refers to known imported credential paths, not a promise
that all durable user data is secret-free. Apply private permissions and never
export these volumes implicitly.

## Implementation tasks

### Resource identity and creation

- [x] Add a storage format version and `storageSetId` to step 02's record.
  Name resources from owner, environment and storage-set identity, with role
  labels and generation labels. Use full IDs for verification after name lookup.
- [x] Persist planned resource names before creation; adopt exact matching
  resources after an ambiguous timeout. Never adopt merely by similar name.
- [x] Create and initialize volumes explicitly before workload startup. Use
  volume mounts with intentional `volume-nocopy` behavior so image defaults are
  not silently copied into state volumes. Initialize permissions with a minimal
  owned helper, then run ordinary work as the existing `node` identity.
- [x] Do not recursively chown populated volumes on every start. Detect UID/GID
  incompatibility and migrate deliberately; verify root-owned fixture files
  remain representable when root setup has created them.
- [x] Add a private storage marker with format, owner, environment and workspace
  generation. Validate labels and contents before mounting a volume read-write.
  A missing/corrupt marker is a recovery condition, never permission to erase it.

### Workspace behavior

- [x] Clone only into a verified newly initialized workspace. Replace the
  current broad cleanup of `/workspace` when `.git` is missing with a refusal
  on unknown nonempty persistent storage. A mount failure must not cause setup
  to initialize the container layer as if persistence were working.
- [x] Validate project identity and checkout baseline on reuse. Preserve
  `.git`, file modes, symlinks, ignored state and environment-private files.
- [x] Keep setup state associated with the correct workspace/runtime contract
  from step 04. A new image can require runtime setup even when Git checkout
  preparation is complete.
- [x] Do not persist arbitrary `/usr`, `/opt` or shell-home modifications.
  Surface the exact preserved paths in rebuild UI; package installation outside
  them must be reproducible through image/project setup.

### Provider-state inventory, before enabling preservation claims

- [x] For all six providers, trace bridge configuration to actual transcript,
  session database, fork lineage, dispatch journal and cache paths. Record an
  explicit allowlist per provider in a proposed backend state-layout module.
- [x] Verify candidate paths such as Codex rollout/session storage, Claude
  project transcripts, Pi session files and OpenCode's database against the
  pinned versions. Do not infer that all of a provider home is portable state.
- [x] Distinguish resume-critical records from caches and host-platform binaries.
  Include SQLite WAL/SHM handling: stop/checkpoint the writer and preserve a
  consistent database set, not just a live main file copied in isolation.
- [x] Handle a provider that cannot relocate a nested state directory using an
  explicit mount at that supported path. Do not introduce writable symlink
  tricks that weaken credential destination checks.
- [x] Keep dispatch deduplication records together with their session identity.
  An ambiguous dispatch survives reconstruction as unknown/recovering, never
  as definitely unsent. Do not manufacture a new turn by resuming a session.
- [x] Advertise per-provider preservation capability. If a resume-critical
  format cannot be preserved, block a claimed lossless rebuild and explain the
  limitation instead of silently dropping its conversations.

## Verification

- [x] Unit tests cover volume specification, naming bounds, marker validation,
  owner mismatch, unknown format and interrupted resource creation.
- [x] Real container stop/start retains tracked edits, binary/untracked/ignored
  files, modes, internal/external symlink text, Git branches and unpushed commits.
- [x] Verify that `/workspace` is actually a named volume and a failed mount
  cannot lead to layer-local writes reported as persistent.
- [ ] For each provider, create a synthetic session, stop writers, attach its
  state to a fresh compatible runtime and resume/read history without duplicate
  dispatch. Use real credentials only in an explicitly authorized agent profile.
- [x] Test disabled providers and absent state directories. Creation must not
  require credentials or execute all six agent CLIs merely to initialize storage.
- [x] Verify old legacy environments still start safely and are not migrated by
  a read, status refresh or UI mount.

## Rollout and exit criteria

Enable this layout for new environments only after the image manifest declares
the matching storage version. Keep a reader for legacy mode. Named volumes are
not backups and can still be removed by a Docker administrator; the product
must accurately distinguish persistence from backup.

Exit when fresh environments have verified persistence and a documented
provider-state matrix. Rollback can stop creating the new layout, but must
retain data and refuse older writers that cannot interpret existing volumes.

## Provider-state inventory (traced 2026-09-27)

The container user is `node` (`HOME=/home/node`). No launcher sets a
vendor-home variable, and before this step Cursor, Grok and Pi bridge state
lived under `/tmp` and Codex bridge state in the writable layer — lost on any
recreate, orphaning the host's provider session ids.

| Provider | Preserved (state volume sub-path → mount) | Not preserved / excluded |
| --- | --- | --- |
| Claude | `claude/projects` → `~/.claude/projects` (SDK transcripts); `claude/file-history` → `~/.claude/file-history` (rewind); `claude/orkestrator` → `~/.claude/orkestrator` (bridge dispatch/steer journals, preferences) | `.credentials.json`, settings, `commands`/`agents`/`plugins`, caches, `~/.claude.json` |
| Codex | `codex/sessions`, `codex/archived_sessions` (rollouts, fork lineage in headers); `codex/orkestrator-bridge` (session map, dispatch journal); `codex/sqlite` via `CODEX_SQLITE_HOME` (runtime DBs, WAL) | `session_index.jsonl` (home root; thread names), `auth.json`, `config.toml`, caches, logs |
| OpenCode | `opencode/db` via `OPENCODE_DB` (session DB, WAL) | `snapshot/` (revert history; entrypoint copies host content into it), `auth.json`, config, plugins, mise installs under `~/.local/share` |
| Pi | `pi/sessions` → `~/.pi/agent/sessions` (`PI_SESSION_DIR`); `pi/bridge-state` → `/tmp/orkestrator-pi-state` | `auth.json`, `models.json`, settings, extensions, themes |
| Cursor | `cursor/bridge-state` → `/tmp/orkestrator-cursor-sdk-state` (SDK JSONL agent store + bridge journals) | `/tmp/orkestrator-ai/cursor-sdk-auth.json`, API-key files, `~/.cursor` auxiliaries |
| Grok | `grok/sessions` → `~/.grok/sessions` (histories + search index, SQLite); `grok/bridge-state` → `/tmp/orkestrator-acp-state` | `active_sessions.json`, `worktrees.db`, `auth.json`, config |

SQLite stores (OpenCode, Grok index, Codex runtime DBs) keep their `-wal`/`-shm`
files on the volume; a copy (step 06) requires the writer to be stopped.
Dispatch journals live beside their session identity, so an ambiguous dispatch
survives reconstruction as unknown rather than unsent.

## Implementation record

- **Image.** `docker/orkestrator-storage.sh` (`persistent-workspace=1`):
  `init`/`verify` against a private marker, refusal of unknown content, foreign
  markers and unexpected ownership; `workspace-setup.sh` clone guard.
- **Backend.** `container-storage.ts` (naming, format selection, exact-label
  volume creation/adoption, helper runs, sub-path mount arguments, removal),
  `container-state-layout.ts` (layout, conditional SQLite relocation,
  per-provider preservation claims). Creation plans and persists the storage
  set (`allocating-storage`) before creating volumes, initializes them and
  mounts them; restarts verify markers first; discard deletes the set and
  bumps the workspace generation; deletion removes volumes after the container
  through a new `volumes` ledger step.
- **Decision.** One `state` volume mounted by sub-path (Engine 26+) rather than
  one volume per provider; older engines keep the legacy layout with a reason.
- **Tests.** `tests/unit/electron/container-storage.test.ts`,
  `apps/backend/src/core/environment-cleanup.test.ts` (volume step). Live
  (Engine 29.7.2): helper init/verify/foreign/unknown-content refusal; C12 —
  tracked/untracked/ignored/binary files, modes, internal and external
  symlinks, branches and an unpushed commit survive stop/start and full runtime
  replacement; a backend-created runtime mounts `/workspace` and all 13 state
  paths node-owned while credential homes stay in the layer.
- **Limitations.** Per-provider synthetic session resume against real agents
  (and qualification of the relocated Codex/Grok databases) is part of step 14.
