# Annotation semantic context budget under aggregate load

- **ID:** 0791
- **Status:** resolved
- **Date observed:** 2026-10-24
- **Test:** `page-side anchor resolver > a reordered card resolves by surrounding context, not by its old structural position`
- **File:** `apps/desktop/tests/browser-preview-annotation-script.test.ts`
- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`
- **Failure:** Expected `matched` / `semantic-context`, but the resolver returned `too-complex` / `none` with no candidates.
- **Isolated rerun:** `mise run test:logged -- --name desktop-annotation-rerun -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./tests/browser-preview-annotation-script.test.ts --parallel=1 --only-failures` passed (0.4 s), with the owning file unchanged.
- **Context:** Tool-group folding validation; concurrent aggregate suites were active in other worktrees. This change does not modify the failing desktop code or tests.
- **Hypothesis:** The bounded resolver can exhaust its wall-clock traversal budget under shared host load. No assertions were weakened or skipped.

## Triage 2026-10-25

- **Disposition:** resolved as a duplicate of [0780](0780-annotation-script-structural-html-custom-element.md). Both cases exhaust the same wall-clock traversal budget in `browser-preview-anchor-script.ts`. Its facts are folded into 0780's triage section, which is the case to follow.

On 2026-11-02, the shared-logger bridge migration saw `two pre-plugin answers stay stale until late plugins are observed and confirmed` fail once in `mise run test` (expected `stale`, received `ready`, 54.49 ms). The owner passed alone twice: `bun test ./src/commands/codex-command-catalogue.test.ts --preload ../../tests/setup-node.ts --only-failures` (30 pass, 0 fail).
