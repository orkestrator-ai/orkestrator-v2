/**
 * Text and structure checks on docker/workspace-setup.sh that start no
 * process. The functional checks of the same script, which run its real
 * functions in bash against real Git repositories, are
 * workspace-setup-preserve.test.ts and workspace-setup-git-mirror.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_CAPABILITIES } from "../../packages/protocol/src/image-manifest";

const repoRoot = join(import.meta.dir, "..", "..");
const setupScript = join(repoRoot, "docker", "workspace-setup.sh");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

describe("workspace setup attachment preservation (structure)", () => {
  test("preserve/restore wrap workspace cleanup, in correct order", () => {
    const setup = read("docker/workspace-setup.sh");

    const cleanupFunction = setup.indexOf("cleanup_orkestrator_workspace_state_backup() {");
    const preserveFunction = setup.indexOf("preserve_orkestrator_workspace_state() {");
    const restoreFunction = setup.indexOf("restore_orkestrator_workspace_state() {");
    const trapRegistration = setup.indexOf("trap cleanup_orkestrator_workspace_state_backup EXIT");
    const convertFn = setup.indexOf("convert_ssh_to_https()");
    const preserveCall = setup.indexOf("preserve_orkestrator_workspace_state", convertFn);
    const workspaceCleanup = setup.indexOf("rm -rf /workspace/*");
    const restoreCall = setup.indexOf("restore_orkestrator_workspace_state", workspaceCleanup);
    const envSetup = setup.indexOf(">>> Setting up environment files <<<");

    expect(cleanupFunction).toBeGreaterThan(-1);
    expect(preserveFunction).toBeGreaterThan(cleanupFunction);
    expect(restoreFunction).toBeGreaterThan(preserveFunction);
    expect(trapRegistration).toBeGreaterThan(cleanupFunction);
    expect(trapRegistration).toBeLessThan(preserveFunction);
    expect(preserveCall).toBeGreaterThan(-1);
    expect(preserveCall).toBeLessThan(workspaceCleanup);
    expect(restoreCall).toBeGreaterThan(workspaceCleanup);
    expect(restoreCall).toBeLessThan(envSetup);
  });

  test("git excludes include runtime workspace artifacts", () => {
    const setup = read("docker/workspace-setup.sh");

    expect(setup).toContain("add_workspace_artifacts_to_git_exclude() {");
    expect(setup).toContain("ensure_git_exclude_trailing_newline() {");
    expect(setup).toContain('local workspace="${WORKSPACE_DIR:-/workspace}"');
    expect(setup).toContain('for pattern in ".orkestrator" ".claude/settings.local.json"; do');
    expect(setup).toContain('grep -qxF "$pattern" "$exclude_file"');
    expect(setup).toContain('append_git_exclude_pattern "$exclude_file" "$pattern"');
    expect(setup.match(/add_workspace_artifacts_to_git_exclude/g)?.length).toBeGreaterThanOrEqual(
      3,
    );
  });

  test("prepare-only stops after checkout restoration and before untrusted setup", () => {
    const setup = read("docker/workspace-setup.sh");
    const workspaceCleanup = setup.indexOf("rm -rf /workspace/*");
    const restoreCall = setup.indexOf("restore_orkestrator_workspace_state", workspaceCleanup);
    const prepareCheckpoint = setup.indexOf('if [ "$PREPARE_ONLY" = true ]');
    const envCopy = setup.indexOf(">>> Setting up environment files <<<");
    const projectSetup = setup.indexOf("=== Running Container Setup ===");

    expect(setup).toContain('if [ "${1:-}" = "--prepare-only" ]; then');
    expect(prepareCheckpoint).toBeGreaterThan(restoreCall);
    expect(prepareCheckpoint).toBeLessThan(envCopy);
    expect(prepareCheckpoint).toBeLessThan(projectSetup);
    expect(setup).not.toContain(".orkestrator-created-from-commit");
  });
});

describe("workspace setup clone move (volume storage)", () => {
  test("setup moves the volume clone with the helper rather than a byte copy", () => {
    const setup = read("docker/workspace-setup.sh");
    expect(setup).toContain('move_clone_into_workspace "$CLONE_DEST" /workspace || exit 1');
    expect(setup).not.toContain('cp -a -n "$CLONE_DEST"');
  });
});

describe("image contract", () => {
  test("the mirror clone uses --reference-if-able with --dissociate", () => {
    const setup = readFileSync(setupScript, "utf8");
    expect(setup).toContain('git clone --no-tags --reference-if-able "$mirror" --dissociate');
    expect(setup).not.toMatch(/git clone[^\n]*--reference "/);
  });

  test("the script declares the capability the backend gates the mount on", () => {
    const setup = readFileSync(setupScript, "utf8");
    expect(setup).toContain(
      `ORKESTRATOR_CAPABILITY git-mirror=${IMAGE_CAPABILITIES["git-mirror"]}`,
    );
  });
});
