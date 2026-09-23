# 04 — Implement safe native persistence and secret editing

Status: done (`source-store.ts`, `document.ts`, `json-edit.ts`, `toml-edit.ts`, `mutation.ts`). No backup
generations are kept; recovery uses operation intent. Depends on: 01–03. [Plan index](00-index.md).

## Purpose

Implement backend-only persistence primitives and provider codecs. The user must
be able to change one server without losing comments, unrelated settings, unknown
provider fields, or a concurrent edit. This step must work without a running
agent. Runtime application is the separate responsibility of step 05.

Proposed modules: `mcp-management/source-store.ts`, `native-file-writer.ts`,
`secret-edits.ts`, and focused JSON, JSONC and TOML adapters. Prefer dependencies
already present. If a parser/editor dependency is required, evaluate comment and
unknown-key preservation and update lockfiles using the pinned Bun workflow.

## Read-modify-write transaction

1. Authenticate and resolve the opaque target/source/entry against current
   environment state. Reject arbitrary paths and protected or policy-owned entries.
2. Acquire a bounded lock keyed by the actual backing file or provider's versioned
   config identity. User and local Claude entries must serialize together.
   Coordinate multiple backend processes where they can share a config root.
3. Open the source safely, enforce byte bounds, and record file identity, metadata,
   source revision and parsed structure. Detect symlinked source/parent paths;
   refuse writes outside allowed roots. Explicitly support a trusted custom config
   root rather than following arbitrary project links into the user's home.
4. Compare `expectedRevision`. If changed, return a conflict plus a fresh redacted
   snapshot; leave the file untouched. Never silently merge two edits to the same
   entry or apply against a truncated catalog.
5. Apply the semantic patch to the selected source subtree. Retain all fields
   outside the patch, including unsupported provider-specific fields. Validate
   the resulting full definition and prospective effective catalog.
6. Build a minimal source edit. Preserve comments, ordering and formatting outside
   the modified subtree where the format supports it. Avoid converting JSONC to
   JSON or pretty-printing an entire large `~/.claude.json` for one entry change.
7. Reparse/validate the candidate and enforce final byte/count bounds. Recheck
   source identity and revision immediately before commit.
8. Commit through provider CAS/versioned write where proven; otherwise write a
   same-directory private temporary file, flush, atomically rename, and flush the
   directory where supported. Preserve safe owner/mode semantics; clean exact
   temporary paths on every failure.
9. Read the resulting source revision and return a redacted result. Invalidate
   all dependent catalogs, then hand the saved revision to the operation service.

Filesystem rename alone is not a compare-and-swap against unrelated editors.
Document the residual last-check/rename race for uncooperative writers; use
provider-native CAS when available, serialize cooperating Orkestrator writers,
and never claim stronger guarantees than the platform provides. If strong CAS is
required for a source and cannot be supplied, keep that source read-only until a
safe provider operation exists. Do not implement stale-lock takeover solely from
an old PID without checking process identity.

## Mutation details

- **Add:** require no same-name entry in the selected source. A same-name entry
  elsewhere yields an override-impact preview, not an implicit overwrite.
- **Update:** use exact entry identity. Preserve unknown fields. Switching between
  stdio and HTTP requires a deliberate field conversion; do not leave stale
  `command` fields that change provider interpretation.
- **Rename:** validate destination collision and provider name grammar; change
  the key and any known provider-owned references in one native transaction.
  Report references that cannot be safely rewritten. Never do two user-visible
  writes with a missing-server interval.
- **Remove:** remove the chosen source entry only. Recompute the effective result
  and reveal any inherited fallback. Do not delete similarly named definitions
  in other files or remove a plugin to remove its server.
- **Persistent enable:** implement only when the provider has proven persisted
  semantics. Do not serialize a guessed universal `disabled` flag.

Do not equate removal with OAuth credential revocation. Keep vendor token-store
cleanup separate and explicit, because another source or session may use it.

## Secret handling

Existing secret-bearing fields stay on the backend. The renderer receives the
field/key identity and whether a value is present or referenced. Resolve `keep`
against the latest revision inside the transaction; reject a stale keep request
rather than moving an unrelated credential into a newly edited definition.

Treat all env/header values as potentially sensitive. URLs can contain query
secrets and command arguments can contain credentials: public summaries and error
messages must redact them too. If a URL or argument cannot safely be shown,
represent it as an opaque retained value with replace/clear controls. Do not
claim that masking only `Authorization` makes arbitrary definitions safe.

Native user config and container overlays can store literal values with private
permissions; make no encryption-at-rest claim. Prefer provider-supported env
references. For project scope, disallow new literal secret fields in the basic
editor and explain how to use references/private scope. Preserve pre-existing
project values opaquely so a harmless edit does not erase them.

Never return raw config via errors, mutation results, SSE, analytics, crash logs,
or generic command tracing. Apply redaction before logging and before exception
serialization. Do not pass secrets on CLI argv; use a private file or stdin when
a pinned provider CLI is the writer. Never create shell command strings from
executable/args supplied by the form.

## Recovery and rollback

Track an operation's intended non-secret metadata and expected source revision
before commit. After an ambiguous result, reread the source and compare intended
outcome privately before retrying. Retry cannot blindly repeat a rename/remove.

If backups are needed for crash recovery, keep one bounded private generation
per actively modified source with explicit expiry, never in a project checkout.
Delete it after successful reconciliation according to the retention policy.
Rollback is a fresh conflict-checked edit against the current revision, not an
automatic overwrite of subsequent external changes. Runtime apply failure alone
does not roll back a valid persisted configuration.

## Verification and acceptance

- [ ] Fixtures preserve comments, unknown keys, unrelated servers and unrelated
  top-level configuration through every mutation.
- [ ] Stale revisions, duplicate names, malformed files, ENOSPC, read-only mounts,
  partial writes, symlink replacement and crashes leave an intact recoverable file.
- [ ] Same-file edits from two windows/backends do not silently lose an update.
- [ ] Rename is atomic and removal correctly reveals lower-precedence entries.
- [ ] Secret keep/replace/clear, env-key rename and URL/arg redaction are tested.
- [ ] Synthetic sentinel credentials never occur in public responses/events/logs.
- [ ] File permissions and temporary-file cleanup are verified on supported OSes.

Exit: [05 — operation lifecycle](05-operations-and-reconciliation.md).
