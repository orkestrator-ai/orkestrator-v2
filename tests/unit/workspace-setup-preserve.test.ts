import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { __testing as commandTesting } from "../../apps/backend/src/core/commands";

const repoRoot = join(import.meta.dir, "..", "..");
const setupScript = join(repoRoot, "docker", "workspace-setup.sh");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function gitAvailable(): boolean {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

function runGit(dir: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  expect(result.status).toBe(0);
}

function runGitExcludeHarness(workspace: string): {
  code: number | null;
  stdout: string;
  stderr: string;
} {
  const harness = `
set -e
GREEN=""; NC=""
WORKSPACE_DIR="$2"
export WORKSPACE_DIR

eval "$(sed -n '/^ensure_git_exclude_trailing_newline() {/,/^}$/p; /^append_git_exclude_pattern() {/,/^}$/p; /^add_workspace_artifacts_to_git_exclude() {/,/^}$/p' "$1")"

add_workspace_artifacts_to_git_exclude
`;
  const result = spawnSync("bash", ["-c", harness, "--", setupScript, workspace], {
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runPreparedWorkspaceValidation(workspace: string): number | null {
  const harness = `
set -e
eval "$(sed -n '/^validate_prepared_workspace() {/,/^}$/p' "$1")"
validate_prepared_workspace "$2"
`;
  return spawnSync("bash", ["-c", harness, "--", setupScript, workspace], {
    encoding: "utf8",
  }).status;
}

function runPrepareOnlyCheckpoint(workspace: string): {
  code: number | null;
  stdout: string;
  stderr: string;
} {
  const harness = `
set -e
GREEN=""; RED=""; NC=""

eval "$(sed -n '/^validate_prepared_workspace() {/,/^}$/p; /^emit_prepare_only_checkpoint() {/,/^}$/p' "$1")"

emit_prepare_only_checkpoint "$2"
`;
  const result = spawnSync("bash", ["-c", harness, "--", setupScript, workspace], {
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runGitScanCacheHarness(options: { insideWorktree: boolean; configFails?: boolean }): {
  code: number | null;
  calls: string[];
} {
  const harnessRoot = mkdtempSync(join(tmpdir(), "ork-git-cache-"));
  const fakeBin = join(harnessRoot, "bin");
  const gitLog = join(harnessRoot, "git.log");
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, "git"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
case "$*" in
  *"rev-parse --is-inside-work-tree"*)
    [ "$FAKE_GIT_INSIDE" = "true" ]
    ;;
  *"config core.untrackedCache true"*)
    [ "$FAKE_GIT_CONFIG_FAILS" != "true" ]
    ;;
  *)
    exit 64
    ;;
esac
`,
  );
  chmodSync(join(fakeBin, "git"), 0o755);

  const harness = `
set -e
WORKSPACE_DIR="$2"
export WORKSPACE_DIR
eval "$(sed -n '/^enable_git_scan_caches() {/,/^}$/p' "$1")"
enable_git_scan_caches
`;
  try {
    const result = spawnSync("bash", ["-c", harness, "--", setupScript, "/workspace under test"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FAKE_GIT_LOG: gitLog,
        FAKE_GIT_INSIDE: options.insideWorktree ? "true" : "false",
        FAKE_GIT_CONFIG_FAILS: options.configFails ? "true" : "false",
      },
    });
    const calls = existsSync(gitLog)
      ? readFileSync(gitLog, "utf8").trim().split("\n").filter(Boolean)
      : [];
    return { code: result.status, calls };
  } finally {
    rmSync(harnessRoot, { recursive: true, force: true });
  }
}

describe("workspace setup prepare-only contract", () => {
  // The backend greps for this exact line before it will invoke --prepare-only.
  // An image whose script lacks it runs the whole setup instead of stopping at the
  // checkpoint, so drift here silently reintroduces a post-setup baseline.
  test("declares the capability marker the backend probes for", () => {
    const setup = read("docker/workspace-setup.sh");
    const marker = commandTesting.CONTAINER_WORKSPACE_SETUP_CAPABILITY_MARKER;

    expect(setup.split("\n")).toContain(marker);
    expect(spawnSync("grep", ["-qxF", marker, setupScript], { encoding: "utf8" }).status).toBe(0);
  });

  test("rejects an unrecognised argument before touching the workspace", () => {
    // The argument check is the first thing the script does, so this runs the real
    // file end to end rather than a sourced fragment.
    const result = spawnSync("bash", [setupScript, "--not-a-real-flag"], { encoding: "utf8" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown workspace setup argument: --not-a-real-flag");
    expect(result.stdout).toBe("");
  });

  test("emits the completion sentinel only for a workspace with a real commit", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ork-ws-checkpoint-"));
    try {
      const withoutRepo = runPrepareOnlyCheckpoint(workspace);
      expect(withoutRepo.code).not.toBe(0);
      expect(withoutRepo.stdout).not.toContain("ORKESTRATOR_PREPARE_OK");
      expect(withoutRepo.stderr).toContain("Workspace preparation failed - no valid Git HEAD");

      if (!gitAvailable()) return;
      runGit(workspace, ["init"]);
      runGit(workspace, ["config", "user.email", "test@example.com"]);
      runGit(workspace, ["config", "user.name", "Test"]);
      writeFileSync(join(workspace, "tracked.txt"), "base\n");
      runGit(workspace, ["add", "tracked.txt"]);
      runGit(workspace, ["commit", "-m", "base"]);

      const prepared = runPrepareOnlyCheckpoint(workspace);
      expect(prepared.code).toBe(0);
      expect(prepared.stdout).toContain(commandTesting.CONTAINER_WORKSPACE_PREPARE_OK_SENTINEL);
      expect(prepared.stdout).toContain("Workspace preparation complete");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("workspace setup Git scan caches", () => {
  test("enables the untracked cache inside a repository", () => {
    const result = runGitScanCacheHarness({ insideWorktree: true });

    expect(result.code).toBe(0);
    expect(result.calls).toEqual([
      "-C /workspace under test rev-parse --is-inside-work-tree",
      "-C /workspace under test config core.untrackedCache true",
    ]);
  });

  test("does not write Git config outside a repository", () => {
    const result = runGitScanCacheHarness({ insideWorktree: false });

    expect(result.code).toBe(0);
    expect(result.calls).toEqual(["-C /workspace under test rev-parse --is-inside-work-tree"]);
  });

  test("keeps setup best-effort when enabling the cache fails", () => {
    const result = runGitScanCacheHarness({ insideWorktree: true, configFails: true });

    expect(result.code).toBe(0);
    expect(result.calls.at(-1)).toBe("-C /workspace under test config core.untrackedCache true");
  });
});

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

  test("prepared workspace validation requires a real commit", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ork-ws-prepare-"));
    try {
      expect(runPreparedWorkspaceValidation(workspace)).not.toBe(0);
      if (!gitAvailable()) return;
      runGit(workspace, ["init"]);
      runGit(workspace, ["config", "user.email", "test@example.com"]);
      runGit(workspace, ["config", "user.name", "Test"]);
      writeFileSync(join(workspace, "tracked.txt"), "base\n");
      runGit(workspace, ["add", "tracked.txt"]);
      runGit(workspace, ["commit", "-m", "base"]);
      expect(runPreparedWorkspaceValidation(workspace)).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

function runHarness(
  scenario: string,
  workspace: string,
): { code: number | null; stdout: string; stderr: string } {
  // Source just the helper function definitions and the global var, then dispatch a scenario.
  // Functions live between the `ORKESTRATOR_WORKSPACE_STATE_BACKUP=""` line and the
  // `convert_ssh_to_https()` definition.
  const harness = `
set -e
GREEN=""; NC=""
ORKESTRATOR_WORKSPACE_STATE_BACKUP=""
ORKESTRATOR_WORKSPACE_STATE_WORKSPACE="/workspace"

eval "$(sed -n '/^cleanup_orkestrator_workspace_state_backup() {/,/^}$/p; /^preserve_orkestrator_workspace_state() {/,/^}$/p; /^restore_orkestrator_workspace_state() {/,/^}$/p' "$1")"

WORKSPACE="$2"
SCENARIO="$3"

case "$SCENARIO" in
  preserve_clear_restore)
    preserve_orkestrator_workspace_state "$WORKSPACE"
    rm -rf "$WORKSPACE"/* 2>/dev/null || true
    rm -rf "$WORKSPACE"/.[!.]* 2>/dev/null || true
    restore_orkestrator_workspace_state "$WORKSPACE"
    ;;
  no_orkestrator)
    preserve_orkestrator_workspace_state "$WORKSPACE"
    if [ -n "$ORKESTRATOR_WORKSPACE_STATE_BACKUP" ]; then
      echo "FAIL: backup var should be empty when .orkestrator missing" >&2
      exit 1
    fi
    restore_orkestrator_workspace_state "$WORKSPACE"
    ;;
  fallback_path)
    preserve_orkestrator_workspace_state "$WORKSPACE"
    rm -rf "$WORKSPACE"/* 2>/dev/null || true
    rm -rf "$WORKSPACE"/.[!.]* 2>/dev/null || true
    mkdir -p "$WORKSPACE"
    echo "cloned-content" > "$WORKSPACE/repo-file.txt"
    restore_orkestrator_workspace_state "$WORKSPACE"
    ;;
  trap_cleanup_on_failure)
    trap cleanup_orkestrator_workspace_state_backup EXIT
    preserve_orkestrator_workspace_state "$WORKSPACE"
    echo "BACKUP_PATH=$ORKESTRATOR_WORKSPACE_STATE_BACKUP"
    echo "$ORKESTRATOR_WORKSPACE_STATE_BACKUP" > "$WORKSPACE/.backup-path"
    exit 1
    ;;
  trap_restore_on_failure_after_clear)
    trap cleanup_orkestrator_workspace_state_backup EXIT
    preserve_orkestrator_workspace_state "$WORKSPACE"
    echo "BACKUP_PATH=$ORKESTRATOR_WORKSPACE_STATE_BACKUP"
    rm -rf "$WORKSPACE"/* 2>/dev/null || true
    rm -rf "$WORKSPACE"/.[!.]* 2>/dev/null || true
    mkdir -p "$WORKSPACE"
    exit 1
    ;;
  restore_replaces_symlink)
    preserve_orkestrator_workspace_state "$WORKSPACE"
    rm -rf "$WORKSPACE"/.orkestrator
    mkdir -p "$WORKSPACE/symlink-target"
    ln -s "$WORKSPACE/symlink-target" "$WORKSPACE/.orkestrator"
    restore_orkestrator_workspace_state "$WORKSPACE"
    ;;
  restore_replaces_file)
    preserve_orkestrator_workspace_state "$WORKSPACE"
    rm -rf "$WORKSPACE"/.orkestrator
    echo "repo-owned placeholder" > "$WORKSPACE/.orkestrator"
    restore_orkestrator_workspace_state "$WORKSPACE"
    ;;
  preserve_symlink_root)
    preserve_orkestrator_workspace_state "$WORKSPACE"
    if [ -n "$ORKESTRATOR_WORKSPACE_STATE_BACKUP" ]; then
      echo "FAIL: symlinked .orkestrator should not be backed up" >&2
      exit 1
    fi
    ;;
  *)
    echo "Unknown scenario: $SCENARIO" >&2
    exit 2
    ;;
esac
`;
  const result = spawnSync("bash", ["-c", harness, "--", setupScript, workspace, scenario], {
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function extractBackupPath(stdout: string): string {
  const match = stdout.match(/^BACKUP_PATH=(\/tmp\/orkestrator-workspace-state\.[^\s]+)$/m);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

describe("workspace setup preserve/restore (functional)", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ork-ws-test-"));
  });

  afterEach(() => {
    if (existsSync(workspace)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("round-trips .orkestrator state through workspace clear", () => {
    mkdirSync(join(workspace, ".orkestrator", "attachments"), { recursive: true });
    writeFileSync(join(workspace, ".orkestrator", "attachments", "image.png"), "binary-content");
    writeFileSync(join(workspace, ".orkestrator", "metadata.json"), `{"key":"value"}`);
    writeFileSync(join(workspace, "stale-file.txt"), "should-be-cleared");

    const result = runHarness("preserve_clear_restore", workspace);

    expect(result.code).toBe(0);
    expect(existsSync(join(workspace, ".orkestrator", "attachments", "image.png"))).toBe(true);
    expect(readFileSync(join(workspace, ".orkestrator", "attachments", "image.png"), "utf8")).toBe(
      "binary-content",
    );
    expect(readFileSync(join(workspace, ".orkestrator", "metadata.json"), "utf8")).toBe(
      `{"key":"value"}`,
    );
    expect(existsSync(join(workspace, "stale-file.txt"))).toBe(false);
  });

  test("no-op when .orkestrator does not exist (existing-repo path)", () => {
    writeFileSync(join(workspace, "existing-file.txt"), "untouched");

    const result = runHarness("no_orkestrator", workspace);

    expect(result.code).toBe(0);
    expect(readFileSync(join(workspace, "existing-file.txt"), "utf8")).toBe("untouched");
  });

  test("preserves attachments alongside fallback-clone files", () => {
    mkdirSync(join(workspace, ".orkestrator"), { recursive: true });
    writeFileSync(join(workspace, ".orkestrator", "attachment.txt"), "preserved");

    const result = runHarness("fallback_path", workspace);

    expect(result.code).toBe(0);
    expect(readFileSync(join(workspace, ".orkestrator", "attachment.txt"), "utf8")).toBe(
      "preserved",
    );
    expect(readFileSync(join(workspace, "repo-file.txt"), "utf8").trim()).toBe("cloned-content");
  });

  test("preserves file modes and symlinks (cp -a fidelity)", () => {
    mkdirSync(join(workspace, ".orkestrator"), { recursive: true });
    const target = join(workspace, ".orkestrator", "data.txt");
    writeFileSync(target, "content");
    chmodSync(target, 0o640);
    symlinkSync("data.txt", join(workspace, ".orkestrator", "link"));

    const result = runHarness("preserve_clear_restore", workspace);

    expect(result.code).toBe(0);
    const restored = join(workspace, ".orkestrator", "data.txt");
    expect(statSync(restored).mode & 0o777).toBe(0o640);
    expect(readlinkSync(join(workspace, ".orkestrator", "link"))).toBe("data.txt");
  });

  test("trap cleans up backup dir when script exits non-zero", () => {
    mkdirSync(join(workspace, ".orkestrator"), { recursive: true });
    writeFileSync(join(workspace, ".orkestrator", "x"), "x");

    const result = runHarness("trap_cleanup_on_failure", workspace);

    expect(result.code).toBe(1);
    const backupPath = extractBackupPath(result.stdout);
    expect(readFileSync(join(workspace, ".backup-path"), "utf8").trim()).toBe(backupPath);
    expect(backupPath).toMatch(/^\/tmp\/orkestrator-workspace-state\./);
    expect(existsSync(backupPath)).toBe(false);
  });

  test("trap restores .orkestrator if setup exits after clearing the workspace", () => {
    mkdirSync(join(workspace, ".orkestrator", "initial-prompt"), { recursive: true });
    writeFileSync(join(workspace, ".orkestrator", "initial-prompt", "image.png"), "preserved");

    const result = runHarness("trap_restore_on_failure_after_clear", workspace);

    expect(result.code).toBe(1);
    const backupPath = extractBackupPath(result.stdout);
    expect(existsSync(backupPath)).toBe(false);
    expect(
      readFileSync(join(workspace, ".orkestrator", "initial-prompt", "image.png"), "utf8"),
    ).toBe("preserved");
  });

  test("restore replaces a cloned .orkestrator symlink instead of writing through it", () => {
    mkdirSync(join(workspace, ".orkestrator"), { recursive: true });
    writeFileSync(join(workspace, ".orkestrator", "attachment.txt"), "preserved");

    const result = runHarness("restore_replaces_symlink", workspace);

    expect(result.code).toBe(0);
    expect(lstatSync(join(workspace, ".orkestrator")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(workspace, ".orkestrator", "attachment.txt"), "utf8")).toBe(
      "preserved",
    );
    expect(existsSync(join(workspace, "symlink-target", "attachment.txt"))).toBe(false);
  });

  test("restore replaces a cloned .orkestrator file with the private state directory", () => {
    mkdirSync(join(workspace, ".orkestrator"), { recursive: true });
    writeFileSync(join(workspace, ".orkestrator", "attachment.txt"), "preserved");

    const result = runHarness("restore_replaces_file", workspace);

    expect(result.code).toBe(0);
    expect(lstatSync(join(workspace, ".orkestrator")).isDirectory()).toBe(true);
    expect(readFileSync(join(workspace, ".orkestrator", "attachment.txt"), "utf8")).toBe(
      "preserved",
    );
  });

  test("preserve skips a symlinked .orkestrator root", () => {
    mkdirSync(join(workspace, "external-state"), { recursive: true });
    writeFileSync(join(workspace, "external-state", "secret.txt"), "outside");
    symlinkSync("external-state", join(workspace, ".orkestrator"));

    const result = runHarness("preserve_symlink_root", workspace);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Skipping symlinked .orkestrator workspace state");
    expect(lstatSync(join(workspace, ".orkestrator")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(workspace, "external-state", "secret.txt"), "utf8")).toBe("outside");
  });

  test("git exclude helper adds runtime artifacts with newline-safe idempotent patterns", () => {
    if (!gitAvailable()) {
      return;
    }

    runGit(workspace, ["init"]);
    writeFileSync(join(workspace, ".git", "info", "exclude"), "existing-pattern");

    const first = runGitExcludeHarness(workspace);
    const second = runGitExcludeHarness(workspace);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const exclude = readFileSync(join(workspace, ".git", "info", "exclude"), "utf8");
    expect(exclude).toBe("existing-pattern\n.orkestrator\n.claude/settings.local.json\n");
    expect(exclude.match(/^\.orkestrator$/gm)?.length).toBe(1);
    expect(exclude.match(/^\.claude\/settings\.local\.json$/gm)?.length).toBe(1);

    mkdirSync(join(workspace, ".orkestrator"), { recursive: true });
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(join(workspace, ".claude", "settings.local.json"), "{}\n");

    const ignored = spawnSync(
      "git",
      [
        "-C",
        workspace,
        "-c",
        "core.excludesFile=/dev/null",
        "check-ignore",
        "-v",
        ".orkestrator",
        ".claude/settings.local.json",
      ],
      { encoding: "utf8" },
    );
    expect(ignored.status).toBe(0);
    expect(ignored.stdout).toContain(".orkestrator");
    expect(ignored.stdout).toContain(".claude/settings.local.json");
  });

  test("git exclude helper resolves linked worktree exclude files", () => {
    if (!gitAvailable()) {
      return;
    }

    const repo = join(workspace, "repo");
    const linkedWorktree = join(workspace, "linked-worktree");
    mkdirSync(repo, { recursive: true });
    runGit(repo, ["init"]);
    runGit(repo, ["config", "user.name", "Test User"]);
    runGit(repo, ["config", "user.email", "test@example.com"]);
    writeFileSync(join(repo, "tracked.txt"), "base\n");
    runGit(repo, ["add", "tracked.txt"]);
    runGit(repo, ["commit", "-m", "base"]);
    runGit(repo, ["worktree", "add", "-b", "linked-branch", linkedWorktree]);

    const excludePathResult = spawnSync(
      "git",
      ["-C", linkedWorktree, "rev-parse", "--git-path", "info/exclude"],
      {
        encoding: "utf8",
      },
    );
    expect(excludePathResult.status).toBe(0);
    expect(lstatSync(join(linkedWorktree, ".git")).isFile()).toBe(true);

    const first = runGitExcludeHarness(linkedWorktree);
    const second = runGitExcludeHarness(linkedWorktree);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const excludePath = excludePathResult.stdout.trim();
    const excludeFile = isAbsolute(excludePath)
      ? excludePath
      : resolve(linkedWorktree, excludePath);
    const exclude = readFileSync(excludeFile, "utf8");
    expect(exclude).toContain(".orkestrator\n");
    expect(exclude).toContain(".claude/settings.local.json\n");
    expect(exclude.match(/^\.orkestrator$/gm)?.length).toBe(1);
    expect(exclude.match(/^\.claude\/settings\.local\.json$/gm)?.length).toBe(1);

    mkdirSync(join(linkedWorktree, ".orkestrator", "clipboard"), { recursive: true });
    mkdirSync(join(linkedWorktree, ".claude"), { recursive: true });
    writeFileSync(join(linkedWorktree, ".orkestrator", "clipboard", "image.png"), "binary");
    writeFileSync(join(linkedWorktree, ".claude", "settings.local.json"), "{}\n");

    const ignored = spawnSync(
      "git",
      [
        "-C",
        linkedWorktree,
        "-c",
        "core.excludesFile=/dev/null",
        "check-ignore",
        ".orkestrator/clipboard/image.png",
        ".claude/settings.local.json",
      ],
      { encoding: "utf8" },
    );
    expect(ignored.status).toBe(0);
  });
});
