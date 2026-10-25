# Legacy migration refused with root-symlink

Seen on branch `todo-0040-mcp-env-delivery-024e7c80895b` (base `06297124`,
2026-10-23) while qualifying
[0040-mcp-environment-delivery.md](../mcp/0040-mcp-environment-delivery.md).

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

## Outstanding work

### Code

1. Find which copied root is a symlink. Re-run the migration with staged Codex
   inputs and capture `orkestrator-migrate.sh`'s raw listing. Then either fix
   the source of the link, or teach the migration to treat that root
   correctly.

### Qualification

- A legacy environment with staged provider inputs migrates to `volume-v1`
  with its workspace and provider state intact. Add this case to
  `container-live-replacement.test.ts`.

## Constraints and rationale

- The refusal fails safe: the original container is kept. Real users with
  staged inputs on legacy environments may hit it when a migration is offered.
  The test fixture differs from a real backend (agent-test flavor, no
  workspace clone), so this has not been reproduced with a real environment.

## Open questions

- Does this reproduce with a real backend migrating a real legacy environment,
  or only in the agent-test fixture?

## Related

- [0019-container-platform-qualification.md](0019-container-platform-qualification.md)
- [`container-lifecycle.md`](../../architecture/container-lifecycle.md)

## Replaces

Nothing; new observation.
