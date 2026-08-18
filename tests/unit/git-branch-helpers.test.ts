import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// `docker/git-branch-helpers.sh` is the branch logic every containerized
// environment runs, and `docker/tests/git-branch-helpers-test.sh` is its only
// coverage. Running it from here is what keeps it in `bun run test` instead of
// depending on somebody invoking the script by hand.
const repoRoot = join(import.meta.dir, "..", "..");
const helperScript = join(repoRoot, "docker", "git-branch-helpers.sh");
const suiteScript = join(repoRoot, "docker", "tests", "git-branch-helpers-test.sh");
const setupScript = join(repoRoot, "docker", "workspace-setup.sh");

function gitAvailable(): boolean {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

describe("docker git branch helpers", () => {
  test("the shell suite ships next to the helpers it covers", () => {
    expect(existsSync(helperScript)).toBe(true);
    expect(existsSync(suiteScript)).toBe(true);
  });

  test.skipIf(!gitAvailable())(
    "the shell suite passes against real repositories",
    () => {
      const result = spawnSync("bash", [suiteScript], {
        encoding: "utf8",
        // The suite asserts on push and upstream configuration, so a developer's own
        // global git settings must not be able to change its outcome.
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      });

      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      // Surface the suite's own FAIL line, which names the assertion that broke.
      if (result.status !== 0) {
        throw new Error(
          `git branch helper suite failed (status ${result.status}):\n${output.trim()}`,
        );
      }
      expect(output).toContain("PASS: git branch helper tests");
    },
    120_000,
  );

  // The branch logic used to be copied into workspace-setup.sh as a fallback, where
  // the suite above could not reach it and the two copies could drift apart. These
  // assertions cover the glue that is left, which is not extractable as a function.
  test("workspace setup delegates to the covered helpers instead of copying them", () => {
    const setup = readFileSync(setupScript, "utf8");

    for (const helper of [
      "configure_same_named_origin_push",
      "create_branch_with_same_named_origin_push",
      "create_branch_from_preferred_bases",
      "checkout_requested_branch",
      "checkout_environment_branch",
    ]) {
      expect(setup).not.toContain(`${helper}() {`);
    }
    expect(setup).toContain('. "/usr/local/bin/git-branch-helpers.sh"');
    expect(setup).toContain('. "$SCRIPT_DIR/git-branch-helpers.sh"');
  });

  test("workspace setup refuses to continue without the helpers or after an unsafe checkout", () => {
    const setup = readFileSync(setupScript, "utf8");

    // A missing helper file must be reported rather than silently skipping branch
    // checkout, and an unsafe branch state must stop setup instead of leaving the
    // workspace on someone else's branch.
    expect(setup).toContain("if ! declare -F checkout_environment_branch >/dev/null; then");
    expect(setup).toContain(
      'checkout_environment_branch "$BRANCH" "$BASE_BRANCH" "$CURRENT" || exit 1',
    );
  });
});
