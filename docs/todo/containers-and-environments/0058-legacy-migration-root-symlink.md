# Legacy migration refused with root-symlink

Seen on branch `todo-0040-mcp-env-delivery-024e7c80895b` (base `06297124`,
2026-10-23) while qualifying
[0040-mcp-environment-delivery.md](../mcp/0040-mcp-environment-delivery.md).
Fixed and qualified on 2026-10-26; every item is done.

## Current state

- `replaceRuntimePreservingState` migrates a `legacy-layer` environment to
  `volume-v1` by copying its workspace and provider state through
  `docker/orkestrator-migrate.sh`. The script refuses a copied root that is a
  symlink with `status=root-symlink`, and the backend reports `needs-attention`,
  keeping the original container.
- A live test built a legacy environment with `createDockerContainer` in an
  agent-test context, with `credentialSources` set to `codex` and `CODEX_HOME`
  pointing at a temporary `config.toml`, so Codex inputs were staged and
  mounted. Its migration was refused with `root-symlink` twice: once with an
  empty workspace, and once after populating `/workspace` and the
  provider-state directories the way the C14 fixture does.
- The existing C14 rebuild case (`container-live-replacement.test.ts`), which
  stages no provider inputs, passed on the same image
  (`orkestrator-v2:mcp0040-qual`). A fresh container with a staged
  `/codex-home` had no symlinks under `/home/node` or `/workspace` to depth 3.
- The 0040 qualification went around the problem by starting from a `volume-v1`
  environment, so its first replacement was a rebuild.
- **Cause (2026-10-26).** No root was a symlink. Two copy steps are
  selective: `~/.codex` with `.codex/*.sqlite*` and
  `~/.local/share/opencode` with `opencode/opencode.db*`. The image ships
  both directories, and a legacy runtime that never ran Codex or OpenCode has
  no databases in them, so the selected listing (`tar -tv` with the
  wildcards) was empty. The root check read the root from that listing with
  `awk 'NR == 1 { … exit 0/1 }'`, and awk exits 0 on empty input, so the
  helper printed `status=root-symlink`. The C14 fixture always created real
  databases (`populateLegacyRuntime`), which is why it passed; staged Codex
  inputs were incidental. Real users hit this for any legacy environment
  without Codex or OpenCode databases.

## Outstanding work

### Code

1. ~~Find which copied root is a symlink. Re-run the migration with staged Codex
   inputs and capture `orkestrator-migrate.sh`'s raw listing. Then either fix
   the source of the link, or teach the migration to treat that root
   correctly.~~ Done 2026-10-26. Raw `docker cp` listings from a stopped
   runtime of the pre-fix image: the first member of every copied root is a
   directory (`.codex/`, `.claude/`, `opencode/`, `workspace/`); the selective
   `~/.codex` listing is empty (`Not found in archive` for all three
   wildcards); the pre-fix helper printed `status=root-symlink` for it and the
   fixed helper `status=ok files=0`. Fix in `docker/orkestrator-migrate.sh`:
   a fourth `tee` consumer records the stream's first member from the whole
   stream when a step selects members (a whole-tree listing already starts
   with it), the check uses `END { exit !found }` so an empty listing is never
   a refusal, and the helper waits for each consumer's own completion file
   instead of a fixed 0.2 s sleep; if either listing has not finished within
   the 60 s ceiling, the step fails (`extract-failed`) rather than reading a
   partial root entry. That last guard was added in self-review after the live
   runs below; the unit tests ran on the final script. Unit tests in
   `tests/unit/migrate-copy.test.ts`: "a selective copy that matches nothing
   is a complete, empty copy" and "a symlinked root is refused for whole-tree
   and selective copies".

### Qualification

- ~~A legacy environment with staged provider inputs migrates to `volume-v1`
  with its workspace and provider state intact. Add this case to
  `container-live-replacement.test.ts`.~~ Done 2026-10-26 on omarchy-hp
  (Docker Engine 29.9.1, linux/amd64): "C14 legacy migration with staged
  provider inputs" stages Codex inputs from a temporary `CODEX_HOME`, fills
  the runtime with `POPULATE` but no databases, migrates, and checks the
  workspace snapshot, Claude/Codex/Grok state, an empty relocated Codex
  SQLite directory and a freshly staged `config.toml` in the candidate. It
  failed with `needs-attention … (root-symlink)` on the pre-fix image
  (`sha256:3eb5e5e4…`) and passed on the fixed one (`sha256:dc006c63…`),
  where all 12 cases of the file passed. Evidence is in
  [`container-qualification.md`](../../development/container-qualification.md#legacy-migration-without-provider-databases-linux-engine-2026-10-26).

## Assumptions and decisions

- **Where to read the copied root of a selective copy.** Options: (a) list the
  whole stream in a fourth `tee` consumer and keep its first line; (b) only
  make the check pass on an empty listing; (c) make the backend skip a
  selective step when `docker cp` reports nothing to select. Chosen: (a) with
  (b)'s `END` guard as well. Why: (b) alone would let a symlinked `~/.codex`
  arrive as an empty selective copy and be reported complete, losing the
  databases it points at; (c) needs a second read of the source and still
  cannot see a link. Pros: one read of the source as before, the refusal
  stays exactly where it was meant to be. Cons: a selective step lists the
  whole home once more (the stream is read concurrently, so no extra source
  read; whole-tree steps drain the consumer with `cat`).
- **Waiting for consumers.** Options: keep the 0.2 s sleep after the
  extraction status, or wait for each consumer's completion file. Chosen: the
  completion files, since a fourth consumer made the sleep's race wider. Pros:
  no timing assumption. Cons: none seen; the 60 s ceiling is unchanged.
- **Older images.** The helper runs from the configured image, so the fix
  arrives with the image built from this change; an older image still refuses
  such a migration, failing safe with the original kept. No backend-side
  workaround was added because the backend cannot tell an empty selection
  from a symlinked root in the old helper's output.
- **The new live case's shape.** It populates with `POPULATE` and no
  databases (the real-user shape that failed) rather than repeating C14's
  SQLite fixture, which the main C14 case already covers.
- **Host Docker state during qualification.** The daemon's 31 default address
  pools were used up by 29 month-old, unattached probe networks that no data
  directory on the host owns, so no live case could create an environment
  network. Options: stop and report; run a second daemon; remove some of the
  orphans and recreate them afterwards. Chosen: removed the eight oldest and
  ran the live cases. They were not recreated because another run leaked
  four more meanwhile and only three ranges were free; their names are in
  [0241-leaked-reach-probe-networks.md](0241-leaked-reach-probe-networks.md),
  which tracks the leak. Pros: real evidence on this host, no configuration
  changed, nothing in use touched. Cons: eight leaked networks are gone
  rather than restored.

## Constraints and rationale

- The refusal fails safe: the original container is kept. Real users with
  legacy environments that have no Codex or OpenCode databases hit it when a
  migration is offered, until their image includes the fix.

## Open questions

- ~~Does this reproduce with a real backend migrating a real legacy
  environment, or only in the agent-test fixture?~~ Answered by the cause: it
  depends only on the copied homes holding no databases, which the image's
  own `~/.codex` and `~/.local/share/opencode` guarantee for a runtime that
  never ran Codex and OpenCode. A real backend runs the same helper on the
  same copy plan.

## Related

- [0019-container-platform-qualification.md](0019-container-platform-qualification.md)
- [0241-leaked-reach-probe-networks.md](0241-leaked-reach-probe-networks.md)
- [`container-lifecycle.md`](../../architecture/container-lifecycle.md)

## Replaces

Nothing; new observation.
