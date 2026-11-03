# The image ships two Claude Code native binaries

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Maintainer decision on the second binary**: keep both, or share one while the pins agree. Status: open.

### 1. Maintainer decision on the second binary

**Problem.** The global CLI and the SDK's vendored binary are both in the image.

**Context.** [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 14 left this open for a maintainer. It recorded on 2026-11-02 that the SDK's `claude-agent-sdk-linux-x64/claude` (0.3.314) and the CLI's `claude-code/bin/claude.exe` (2.1.314) were the same file at 298 MB. [`upgrade-agents.md`](../../development/upgrade-agents.md) says the SDK deliberately does not track the CLI, so they can diverge.

**Investigation.** The pins are unchanged: `CLAUDE_CLI_VERSION=2.1.314` (`docker/Dockerfile:207`) and `@anthropic-ai/claude-agent-sdk` 0.3.314 (`bridges/claude-bridge/package.json:16`). The CLI is installed at `docker/Dockerfile:217`; the bridge vendors its SDK at `:62-65`, and it ships in its own layer at `:423`.

**Decisions.**

- **Keep both, or share?** (1202 recommends the first; only a maintainer can decide.)
  - **At build time, symlink the SDK binary to the CLI's when the two are byte-identical, otherwise copy it (recommended).** This needs a `RUN --mount=type=bind,from=bridge-build`, which is a bind mount, not the cache mount 0022 rejected.
    - Pros: saves 298 MB while the pins agree; no change when they diverge.
    - Cons: the bridge's SDK would run whatever is at the CLI path, so a user's `npm i -g @anthropic-ai/claude-code@<other>` inside a container would change the bridge's engine too; adds BuildKit-only syntax.
  - **Leave both copies.**
    - Pros: the SDK stays self-contained and follows its own release train.
    - Cons: 298 MB of identical bytes in every image.

## Constraints and rationale

The bridge deliberately separates the two release trains (`docker/Dockerfile:205-206`). The DK-7 layer order must survive either choice, or a release re-pulls more.

## Needs verification

- That the two files are still identical at these pins; this analysis did not build the image.

## Related

- [Efficiency report, G](../2026-10-27-efficiency.md#g-desktop-toolchain-docker-image-protocol-and-cli)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 14
- [0022 container resource budgets](../../todo/containers-and-environments/0022-container-resource-budgets-and-performance.md)
