# The image ships a second Claude Code binary that the container bridge never runs

## Task analysis

Analysed 2026-11-05 against `main` at `cbe0f9a5b`.

### Tasks

2. **Build and qualify the chosen option**: change `docker/Dockerfile`, its tests and the image checks, then prove the bridge still works in a container. Status: blocked (waits on 7568: 6780 task 1).

### 2. Build and qualify the chosen option

**Problem.** Whichever option is chosen other than leaving both, the image changes, and the bridge must still start and drive Claude in a container.

**Context.** The image checks are `docker/tests/final-image-smoke.sh` (bridge health for all five bridges) and `mise run test:agent:docker:isolated`; layer re-pull was measured for DK-7 in 1202 task 14 by comparing `RootFS.Layers` digests.

**Investigation.** Not started; it waits on the maintainer's choice (7568: 6780 task 1). Nothing in the Dockerfile was changed by the 2026-11-05 check.

**Decisions.**

- **How much live proof is needed?**
  - **Final-image smoke, the isolated Docker suite, `docker history` before and after, and one credential-free bridge request that spawns the CLI, such as a model catalogue refresh (`claude-model-catalog.ts`, a control-only query) (recommended).**
    - Pros: proves the bridge spawns the CLI with the SDK copy gone or linked, without a billed turn; shows the saving and that DK-7's layer order still holds.
    - Cons: an image build and a suite run on a shared host, about 10–15 minutes.
  - **Smoke only.**
    - Pros: fast.
    - Cons: the smoke checks bridge health, and the bridge's `/global/auth-check` answers without spawning the CLI (`bridges/claude-bridge/src/index.ts:184`), so a missing engine could go unnoticed until a user's first turn.

## Evidence for the maintainer's choice

The choice itself (drop the SDK copy, link it, or keep both) moved to the [manual-test checklist](../manual-test/7568-manual-test-checklist.md) on 2026-11-10; the evidence and the options it rests on stay here.

**Problem.** Every image carries two copies of the same 298 MB Claude Code native binary: the global CLI's and the one the Claude Agent SDK vendors into the Claude bridge.

**Context.** This is efficiency finding DK-10 (report, section G (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`)), carried by to-do 1202 (retired 2026-11-10) task 14 and then by efficiency report 0693, which was checked back and deleted on 2026-11-05 (its last version is in the commit before the one that deleted it). [`upgrade-agents.md`](../../development/upgrade-agents.md) says the SDK deliberately does not track the CLI, and the Dockerfile says the same at `docker/Dockerfile:205-206`, so the two pins can diverge.

Where the two copies come from, on `main` at `cbe0f9a5b`:

- The CLI pin is `ARG CLAUDE_CLI_VERSION=2.1.314` (`docker/Dockerfile:207`). `npm install -g` at `:217-218` installs it; its postinstall (`install.cjs`) hard-links the platform package's `claude` to `bin/claude.exe`, so the CLI layer holds one copy. `ENV CLAUDE_CLI_PATH=/usr/local/share/npm-global/bin/claude` is at `:219`, and `:287` fails the build if it does not run.
- The SDK pin is `@anthropic-ai/claude-agent-sdk` `0.3.314` (`bridges/claude-bridge/package.json:16`). The bridge build vendors every installed platform package into `dist/node_modules` (`bridges/claude-bridge/scripts/vendor.ts`), the builder drops the musl variants and moves the rest to `/opt/bridge-deps/claude-bridge` (`docker/Dockerfile:62-65`), and the final stage ships them in their own layer (`:425`), ahead of the bundles, as DK-7 requires. `:437-440` checks that layer.

**Investigation.** Both pins are the same as when 0693 was analysed at `a2bba9d8`; the Dockerfile has moved only by the root-ownership change to the bridge `COPY` lines, so the layer `COPY` is now at `:425` rather than `:423`.

The pinned tarballs were downloaded from the npm registry into a git-ignored directory, their SHA-512 integrity checked against the registry (the SDK's linux-x64 package also against `bun.lock`), and the binaries hashed. They are byte-identical on both architectures:

| Architecture | CLI 2.1.314 (`@anthropic-ai/claude-code-linux-<arch>/claude`) | SDK 0.3.314 (`@anthropic-ai/claude-agent-sdk-linux-<arch>/claude`) | SHA-256 (both) |
| --- | --- | --- | --- |
| x64 | 298,229,464 bytes | 298,229,464 bytes | `4487042b4c4f5d88d4568f68ae98aae0b1ffae58864cf57fb868641bc5f84594` |
| arm64 | 297,067,016 bytes | 297,067,016 bytes | `a66c0a8f5d0c87a439953d797985192bbcbaefbce2e0d7b2eaa8df30ef0f3ef2` |

The x64 hash is the one 1202 task 14 recorded on 2026-11-02. A local amd64 dev image built on 2026-11-05 from the same pins (`claude --version` 2.1.314, SDK 0.3.314) showed the same thing inside the image: `/opt/claude-bridge/dist/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude` (root-owned, one link) and the CLI's `bin/claude.exe` (node-owned, two links, the hard link above) both 298,229,464 bytes with that hash. `docker history` puts the claude-bridge SDK layer at 303 MB and the Claude Code npm layer at 301 MB.

This check also found that **the container bridge never runs the SDK's copy**. Every production SDK call in the bridge passes `claudeExecutableOptions()` (`bridges/claude-bridge/src/services/session-manager-core.ts:169-173`), which sets `pathToClaudeCodeExecutable` from `CLAUDE_CLI_PATH`: the turn launch (`session-manager-prompt-query.ts:410`), the command, MCP and catalogue probes, sign-in and the model catalogue. `session-manager-interactions.ts:238` reads the variable directly to report the CLI version. The SDK falls back to its own platform binary only when that option is absent. In a container the bridge is started by `docker exec` (`launchContainerScript`, `apps/backend/src/core/container-bridge-credential.ts:210`, from `commands-containers.ts:946`), so it inherits the image's `ENV CLAUDE_CLI_PATH`; the runtime-env script does not change it (checked in the image: the value is the same before and after sourcing it). So the 298 MB SDK copy is a fallback for a variable the image always sets, and when the pins diverge the container bridge already runs the CLI's version, not the SDK's.

**Decisions.**

- **What to do with the SDK's binary in the image?** Only a maintainer can decide; this is a recommendation.
  - **Leave both copies.**
    - Pros: no change; the SDK package stays complete, so a bridge started with `CLAUDE_CLI_PATH` unset still has an engine.
    - Cons: 298 MB (amd64) or 297 MB (arm64) of bytes in every image and every first pull that, in the image's own configuration, are never executed.
  - **At build time, symlink the SDK's binary to the CLI's when they are byte-identical, otherwise copy it (1202's recommendation).** This needs a `RUN --mount=type=bind,from=bridge-build` in place of the `COPY` at `:425`; that is a bind mount, not the cache mount 0022 rejected.
    - Pros: saves the 298 MB while the pins agree, as they do today; no change when they diverge. The coupling 0693 listed as its main cost (a user's `npm i -g @anthropic-ai/claude-code@<other>` changing the bridge's engine) already exists, because the bridge runs `CLAUDE_CLI_PATH` today.
    - Cons: saves nothing once the pins diverge, yet the bridge still runs the CLI then, so the kept copy buys nothing; adds BuildKit-only syntax and a hash comparison in a `RUN`; turns the SDK layer from a `COPY` into a `RUN`, which must stay in the same place for DK-7; puts a root-owned link in `/opt/claude-bridge` pointing at a node-owned file, which the root-ownership rule for bridge code (`:421-422`) would have to accept.
  - **Drop the SDK's platform binary in the builder, as it already drops the musl variant (recommended).** One more `rm -rf` of `dist/node_modules/@anthropic-ai/claude-agent-sdk-linux-*` at `:64` (the main `claude-agent-sdk` package stays), and the check at `:440` widened to match.
    - Pros: saves the 297–298 MB on both architectures whatever the pins are; changes nothing the container bridge runs; keeps the `COPY` layer, its place and DK-7's order, with a smaller layer; no BuildKit syntax and no link from root-owned code to node-owned files; one line in the builder plus a test.
    - Cons: no fallback engine: a bridge started without `CLAUDE_CLI_PATH`, or with a broken CLI at that path, fails with the SDK's "executable not found" error instead of running the SDK's own copy (today a broken CLI fails the same way, since the variable is set); `tests/unit/version-drift.test.ts:585` and the comment at `docker/Dockerfile:57-60` need updating; a future SDK that resolved its binary even when given a path would break this, so the qualification in task 2 must cover it.

  The recommendation is to drop the copy. It is the only option that keeps the saving after the pins diverge, which `upgrade-agents.md` expects them to, and the verified facts above show the copy is not what the container bridge runs. The symlink option was recommended before it was known that the bridge never runs the SDK's binary in a container.

## Constraints and rationale

- The bridge deliberately follows the SDK's release train, separate from the CLI's (`docker/Dockerfile:205-206`, `upgrade-agents.md`). None of the options changes either pin.
- DK-7's layer order (vendored SDKs in their own layers ahead of the bundles, `:416-425`) must survive, or a bridge-only release re-pulls hundreds of megabytes again.
- Bridge code in the image is root-owned so the agent's uid cannot replace it (`:421-422`).

## Open questions

- The desktop package vendors the same SDK platform packages through `vendor.ts`, and host bridges also always get `CLAUDE_CLI_PATH` (`apps/backend/src/core/commands-servers.ts:1050`). Whether that copy can go too was not checked; it is outside DK-10, which is about the image.

## Related

- to-do 1202 efficiency follow-ups, task 14 (retired 2026-11-10)
- To-do 0022, container resource budgets (retired 2026-11-11): [Built-in default](../../architecture/container-lifecycle.md#built-in-default) and [Optimisations measured and not taken](../../development/container-qualification.md#optimisations-measured-and-not-taken)
- Efficiency, logging and database outcome (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`), closing note for 0693
- [`upgrade-agents.md`](../../development/upgrade-agents.md)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, the maintainer's choice for the second binary) moved there on 2026-11-10.
