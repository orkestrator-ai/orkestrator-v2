import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
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

type GitScanCacheCase = { insideWorktree: boolean; configFails?: boolean };

/**
 * Runs `enable_git_scan_caches` once per case in one bash process, each case in
 * its own subshell with a fake `git` that logs its calls to that case's log.
 */
function runGitScanCacheHarness(cases: readonly GitScanCacheCase[]): Array<{
  code: number | null;
  calls: string[];
}> {
  const harnessRoot = mkdtempSync(join(tmpdir(), "ork-git-cache-"));
  const fakeBin = join(harnessRoot, "bin");
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
WORKSPACE_DIR="$2"
export WORKSPACE_DIR
eval "$(sed -n '/^enable_git_scan_caches() {/,/^}$/p' "$1")"
RESULTS="$3"
shift 3
index=0
while [ $# -gt 0 ]; do
  (
    set -e
    FAKE_GIT_LOG="$RESULTS/$index.log" FAKE_GIT_INSIDE="$1" FAKE_GIT_CONFIG_FAILS="$2"
    export FAKE_GIT_LOG FAKE_GIT_INSIDE FAKE_GIT_CONFIG_FAILS
    enable_git_scan_caches
  )
  printf '%s' "$?" > "$RESULTS/$index.code"
  index=$((index + 1))
  shift 2
done
`;
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        harness,
        "--",
        setupScript,
        "/workspace under test",
        harnessRoot,
        ...cases.flatMap(({ insideWorktree, configFails }) => [
          insideWorktree ? "true" : "false",
          configFails ? "true" : "false",
        ]),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      },
    );
    expect(result.status).toBe(0);
    return cases.map((_, index) => {
      const gitLog = join(harnessRoot, `${index}.log`);
      return {
        code: Number(readFileSync(join(harnessRoot, `${index}.code`), "utf8")),
        calls: existsSync(gitLog)
          ? readFileSync(gitLog, "utf8").trim().split("\n").filter(Boolean)
          : [],
      };
    });
  } finally {
    rmSync(harnessRoot, { recursive: true, force: true });
  }
}

let committedTemplate: string | undefined;

/**
 * Copies a repository with one commit (`tracked.txt`, "base") into `destination`.
 * The template is built with real Git once per file; a plain repository
 * records no path of its own, so a copy is a whole repository.
 */
function copyCommittedRepository(destination: string): void {
  if (committedTemplate === undefined) {
    const template = mkdtempSync(join(tmpdir(), "ork-ws-committed-"));
    runGit(template, ["init"]);
    runGit(template, ["config", "user.email", "test@example.com"]);
    runGit(template, ["config", "user.name", "Test"]);
    writeFileSync(join(template, "tracked.txt"), "base\n");
    runGit(template, ["add", "tracked.txt"]);
    runGit(template, ["commit", "-m", "base"]);
    committedTemplate = template;
  }
  cpSync(committedTemplate, destination, { recursive: true });
}

afterAll(() => {
  if (committedTemplate !== undefined) rmSync(committedTemplate, { recursive: true, force: true });
});

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
      copyCommittedRepository(workspace);

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
  let results: ReturnType<typeof runGitScanCacheHarness>;

  beforeAll(() => {
    results = runGitScanCacheHarness([
      { insideWorktree: true },
      { insideWorktree: false },
      { insideWorktree: true, configFails: true },
    ]);
  });

  test("enables the untracked cache inside a repository", () => {
    const result = results[0]!;

    expect(result.code).toBe(0);
    expect(result.calls).toEqual([
      "-C /workspace under test rev-parse --is-inside-work-tree",
      "-C /workspace under test config core.untrackedCache true",
    ]);
  });

  test("does not write Git config outside a repository", () => {
    const result = results[1]!;

    expect(result.code).toBe(0);
    expect(result.calls).toEqual(["-C /workspace under test rev-parse --is-inside-work-tree"]);
  });

  test("keeps setup best-effort when enabling the cache fails", () => {
    const result = results[2]!;

    expect(result.code).toBe(0);
    expect(result.calls.at(-1)).toBe("-C /workspace under test config core.untrackedCache true");
  });
});

function runAgentTestRemoteTrust(home: string, remote: string | undefined): string {
  const harness = `
set -e
eval "$(sed -n '/^AGENT_TEST_GIT_REMOTE_PATH=/p; /^trust_agent_test_git_remote() {/,/^}$/p' "$1")"
trust_agent_test_git_remote
trust_agent_test_git_remote
git config --global --get-all safe.directory || true
`;
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home };
  if (remote !== undefined) env.ORKESTRATOR_AGENT_TEST_GIT_REMOTE = remote;
  const result = spawnSync("bash", ["-c", harness, "--", setupScript], { encoding: "utf8", env });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe("workspace setup agent-test Git remote trust", () => {
  test("trusts the fixed fixture path once, and nothing otherwise", () => {
    if (!gitAvailable()) return;
    const home = mkdtempSync(join(tmpdir(), "orkestrator-setup-trust-"));
    try {
      expect(runAgentTestRemoteTrust(home, undefined)).toBe("");
      expect(runAgentTestRemoteTrust(home, "/elsewhere.git")).toBe("");
      expect(runAgentTestRemoteTrust(home, "/orkestrator-agent-test-origin.git")).toBe(
        "/orkestrator-agent-test-origin.git\n",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("workspace setup attachment preservation (structure)", () => {
  test("an interrupted volume clone keeps its marker while partial files are cleaned", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ork-ws-volume-clone-"));
    try {
      const state = join(workspace, ".orkestrator");
      mkdirSync(join(state, ".clone-in-progress"), { recursive: true });
      writeFileSync(join(state, "storage-marker.json"), '{"environmentId":"env-1"}');
      writeFileSync(join(state, ".clone-copy-in-progress"), "");
      writeFileSync(join(workspace, "partial-file"), "partial");
      const setup = read("docker/workspace-setup.sh");
      const start = setup.indexOf("    # Clean /workspace");
      const end = setup.indexOf("    print_workspace_disk_status", start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const cleanup = setup.slice(start, end).replaceAll("/workspace", workspace);
      const result = spawnSync(
        "bash",
        ["-c", `preserve_orkestrator_workspace_state() { :; }\n${cleanup}`],
        {
          env: { ...process.env, ORKESTRATOR_WORKSPACE_STORAGE: "volume-v1" },
        },
      );
      expect(result.status).toBe(0);
      expect(existsSync(join(state, "storage-marker.json"))).toBe(true);
      expect(existsSync(join(workspace, "partial-file"))).toBe(false);
      expect(existsSync(join(state, ".clone-in-progress"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  test("prepared workspace validation requires a real commit", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ork-ws-prepare-"));
    try {
      expect(runPreparedWorkspaceValidation(workspace)).not.toBe(0);
      if (!gitAvailable()) return;
      copyCommittedRepository(workspace);
      expect(runPreparedWorkspaceValidation(workspace)).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

type HarnessResult = { code: number | null; stdout: string; stderr: string };

const SCENARIOS = String.raw`
run_scenario() {
WORKSPACE="$1"
SCENARIO="$2"

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
}
`;

/**
 * Runs every scenario in one bash process. It sources just the helper function
 * definitions once; each scenario then runs in its own subshell under
 * `set -e`, with fresh globals, its own EXIT trap and its own workspace, and
 * writes its status and output beside the workspace rather than in it.
 */
function runHarnessBatch(
  cases: ReadonlyArray<{ name: string; scenario: string; workspace: string }>,
  results: string,
): Map<string, HarnessResult> {
  const harness = [
    'eval "$(sed -n \'/^cleanup_orkestrator_workspace_state_backup() {/,/^}$/p; /^preserve_orkestrator_workspace_state() {/,/^}$/p; /^restore_orkestrator_workspace_state() {/,/^}$/p\' "$1")"',
    SCENARIOS,
    'RESULTS="$2"',
    "shift 2",
    "while [ $# -gt 0 ]; do",
    '  ( set -e; GREEN=""; NC=""; ORKESTRATOR_WORKSPACE_STATE_BACKUP=""; ORKESTRATOR_WORKSPACE_STATE_WORKSPACE="/workspace"; run_scenario "$2" "$3" ) > "$RESULTS/$1.stdout" 2> "$RESULTS/$1.stderr"',
    '  printf \'%s\' "$?" > "$RESULTS/$1.code"',
    "  shift 3",
    "done",
  ].join("\n");
  const args = cases.flatMap(({ name, scenario, workspace }) => [name, workspace, scenario]);
  const result = spawnSync("bash", ["-c", harness, "--", setupScript, results, ...args], {
    encoding: "utf8",
  });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  return new Map(
    cases.map(({ name }) => [
      name,
      {
        code: Number(readFileSync(join(results, `${name}.code`), "utf8")),
        stdout: readFileSync(join(results, `${name}.stdout`), "utf8"),
        stderr: readFileSync(join(results, `${name}.stderr`), "utf8"),
      },
    ]),
  );
}

function extractBackupPath(stdout: string): string {
  const match = stdout.match(/^BACKUP_PATH=(\/tmp\/orkestrator-workspace-state\.[^\s]+)$/m);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

describe("workspace setup preserve/restore (functional)", () => {
  // Each case prepares its own workspace; one shell then runs every scenario.
  const cases: Array<{ name: string; scenario: string; prepare: (workspace: string) => void }> = [
    {
      name: "round-trip",
      scenario: "preserve_clear_restore",
      prepare: (workspace) => {
        mkdirSync(join(workspace, ".orkestrator", "attachments"), { recursive: true });
        writeFileSync(
          join(workspace, ".orkestrator", "attachments", "image.png"),
          "binary-content",
        );
        writeFileSync(join(workspace, ".orkestrator", "metadata.json"), `{"key":"value"}`);
        writeFileSync(join(workspace, "stale-file.txt"), "should-be-cleared");
      },
    },
    {
      name: "no-orkestrator",
      scenario: "no_orkestrator",
      prepare: (workspace) => writeFileSync(join(workspace, "existing-file.txt"), "untouched"),
    },
    {
      name: "fallback",
      scenario: "fallback_path",
      prepare: (workspace) => {
        mkdirSync(join(workspace, ".orkestrator"), { recursive: true });
        writeFileSync(join(workspace, ".orkestrator", "attachment.txt"), "preserved");
      },
    },
    {
      name: "fidelity",
      scenario: "preserve_clear_restore",
      prepare: (workspace) => {
        mkdirSync(join(workspace, ".orkestrator"), { recursive: true });
        const target = join(workspace, ".orkestrator", "data.txt");
        writeFileSync(target, "content");
        chmodSync(target, 0o640);
        symlinkSync("data.txt", join(workspace, ".orkestrator", "link"));
      },
    },
    {
      name: "trap-cleanup",
      scenario: "trap_cleanup_on_failure",
      prepare: (workspace) => {
        mkdirSync(join(workspace, ".orkestrator"), { recursive: true });
        writeFileSync(join(workspace, ".orkestrator", "x"), "x");
      },
    },
    {
      name: "trap-restore",
      scenario: "trap_restore_on_failure_after_clear",
      prepare: (workspace) => {
        mkdirSync(join(workspace, ".orkestrator", "initial-prompt"), { recursive: true });
        writeFileSync(join(workspace, ".orkestrator", "initial-prompt", "image.png"), "preserved");
      },
    },
    {
      name: "replaces-symlink",
      scenario: "restore_replaces_symlink",
      prepare: (workspace) => {
        mkdirSync(join(workspace, ".orkestrator"), { recursive: true });
        writeFileSync(join(workspace, ".orkestrator", "attachment.txt"), "preserved");
      },
    },
    {
      name: "replaces-file",
      scenario: "restore_replaces_file",
      prepare: (workspace) => {
        mkdirSync(join(workspace, ".orkestrator"), { recursive: true });
        writeFileSync(join(workspace, ".orkestrator", "attachment.txt"), "preserved");
      },
    },
    {
      name: "symlink-root",
      scenario: "preserve_symlink_root",
      prepare: (workspace) => {
        mkdirSync(join(workspace, "external-state"), { recursive: true });
        writeFileSync(join(workspace, "external-state", "secret.txt"), "outside");
        symlinkSync("external-state", join(workspace, ".orkestrator"));
      },
    },
  ];
  let root: string;
  let results: Map<string, HarnessResult>;
  const workspaceOf = (name: string) => join(root, "workspaces", name);

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ork-ws-test-"));
    mkdirSync(join(root, "results"));
    for (const { name, prepare } of cases) {
      mkdirSync(workspaceOf(name), { recursive: true });
      prepare(workspaceOf(name));
    }
    results = runHarnessBatch(
      cases.map(({ name, scenario }) => ({ name, scenario, workspace: workspaceOf(name) })),
      join(root, "results"),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("round-trips .orkestrator state through workspace clear", () => {
    const workspace = workspaceOf("round-trip");
    expect(results.get("round-trip")!.code).toBe(0);
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
    expect(results.get("no-orkestrator")!.code).toBe(0);
    expect(readFileSync(join(workspaceOf("no-orkestrator"), "existing-file.txt"), "utf8")).toBe(
      "untouched",
    );
  });

  test("preserves attachments alongside fallback-clone files", () => {
    const workspace = workspaceOf("fallback");
    expect(results.get("fallback")!.code).toBe(0);
    expect(readFileSync(join(workspace, ".orkestrator", "attachment.txt"), "utf8")).toBe(
      "preserved",
    );
    expect(readFileSync(join(workspace, "repo-file.txt"), "utf8").trim()).toBe("cloned-content");
  });

  test("preserves file modes and symlinks (cp -a fidelity)", () => {
    const workspace = workspaceOf("fidelity");
    expect(results.get("fidelity")!.code).toBe(0);
    const restored = join(workspace, ".orkestrator", "data.txt");
    expect(statSync(restored).mode & 0o777).toBe(0o640);
    expect(readlinkSync(join(workspace, ".orkestrator", "link"))).toBe("data.txt");
  });

  test("trap cleans up backup dir when script exits non-zero", () => {
    const result = results.get("trap-cleanup")!;
    expect(result.code).toBe(1);
    const backupPath = extractBackupPath(result.stdout);
    expect(readFileSync(join(workspaceOf("trap-cleanup"), ".backup-path"), "utf8").trim()).toBe(
      backupPath,
    );
    expect(backupPath).toMatch(/^\/tmp\/orkestrator-workspace-state\./);
    expect(existsSync(backupPath)).toBe(false);
  });

  test("trap restores .orkestrator if setup exits after clearing the workspace", () => {
    const result = results.get("trap-restore")!;
    expect(result.code).toBe(1);
    const backupPath = extractBackupPath(result.stdout);
    expect(existsSync(backupPath)).toBe(false);
    expect(
      readFileSync(
        join(workspaceOf("trap-restore"), ".orkestrator", "initial-prompt", "image.png"),
        "utf8",
      ),
    ).toBe("preserved");
  });

  test("restore replaces a cloned .orkestrator symlink instead of writing through it", () => {
    const workspace = workspaceOf("replaces-symlink");
    expect(results.get("replaces-symlink")!.code).toBe(0);
    expect(lstatSync(join(workspace, ".orkestrator")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(workspace, ".orkestrator", "attachment.txt"), "utf8")).toBe(
      "preserved",
    );
    expect(existsSync(join(workspace, "symlink-target", "attachment.txt"))).toBe(false);
  });

  test("restore replaces a cloned .orkestrator file with the private state directory", () => {
    const workspace = workspaceOf("replaces-file");
    expect(results.get("replaces-file")!.code).toBe(0);
    expect(lstatSync(join(workspace, ".orkestrator")).isDirectory()).toBe(true);
    expect(readFileSync(join(workspace, ".orkestrator", "attachment.txt"), "utf8")).toBe(
      "preserved",
    );
  });

  test("preserve skips a symlinked .orkestrator root", () => {
    const workspace = workspaceOf("symlink-root");
    const result = results.get("symlink-root")!;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Skipping symlinked .orkestrator workspace state");
    expect(lstatSync(join(workspace, ".orkestrator")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(workspace, "external-state", "secret.txt"), "utf8")).toBe("outside");
  });
});

// The Git exclude cases need a repository per case, so they run one by one.
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
    copyCommittedRepository(repo);
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

describe("workspace setup clone move (volume storage)", () => {
  function runMove(clone: string, workspace: string) {
    const harness = `
set -e
RED=""; NC=""
eval "$(sed -n '/^move_clone_into_workspace() {/,/^}$/p' "$1")"
move_clone_into_workspace "$2" "$3"
`;
    return spawnSync("bash", ["-c", harness, "bash", setupScript, clone, workspace], {
      encoding: "utf8",
    });
  }

  function stagedClone(workspace: string): string {
    const state = join(workspace, ".orkestrator");
    const clone = join(state, ".clone-in-progress");
    mkdirSync(join(clone, ".git", "objects"), { recursive: true });
    mkdirSync(join(clone, "src"), { recursive: true });
    writeFileSync(join(clone, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(clone, "src", "index.ts"), "export {};\n");
    writeFileSync(join(clone, ".env.example"), "A=1\n");
    writeFileSync(join(clone, "file with spaces"), "x");
    symlinkSync("src/index.ts", join(clone, "entry"));
    // A repository's own .orkestrator folder: the restore replaces it anyway.
    mkdirSync(join(clone, ".orkestrator"), { recursive: true });
    writeFileSync(join(clone, ".orkestrator", "tracked.json"), "{}");
    writeFileSync(join(state, "storage-marker.json"), '{"environmentId":"env-1"}');
    writeFileSync(join(state, ".clone-copy-in-progress"), "");
    return clone;
  }

  test("renames every entry into the workspace instead of copying it", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ork-ws-clone-move-"));
    try {
      const clone = stagedClone(workspace);
      const sourceInode = statSync(join(clone, "src", "index.ts")).ino;
      const gitInode = statSync(join(clone, ".git")).ino;

      const result = runMove(clone, workspace);

      expect(result.status).toBe(0);
      expect(existsSync(clone)).toBe(false);
      // Same inode: the entries were renamed within the volume, not copied.
      expect(statSync(join(workspace, "src", "index.ts")).ino).toBe(sourceInode);
      expect(statSync(join(workspace, ".git")).ino).toBe(gitInode);
      expect(readFileSync(join(workspace, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
      expect(readFileSync(join(workspace, ".env.example"), "utf8")).toBe("A=1\n");
      expect(readFileSync(join(workspace, "file with spaces"), "utf8")).toBe("x");
      expect(readlinkSync(join(workspace, "entry"))).toBe("src/index.ts");
      // The workspace's own state is untouched by the repository's folder.
      expect(existsSync(join(workspace, ".orkestrator", "storage-marker.json"))).toBe(true);
      expect(existsSync(join(workspace, ".orkestrator", "tracked.json"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("an entry that cannot be moved fails and keeps the staged clone for the retry", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ork-ws-clone-move-"));
    try {
      const clone = stagedClone(workspace);
      // Something already in the way: mv -n skips it silently.
      mkdirSync(join(workspace, "src", "existing"), { recursive: true });

      const result = runMove(clone, workspace);

      expect(result.status).not.toBe(0);
      expect(existsSync(join(clone, "src", "index.ts"))).toBe(true);
      expect(existsSync(join(workspace, "src", "existing"))).toBe(true);
      expect(existsSync(join(workspace, ".orkestrator", ".clone-copy-in-progress"))).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("preserves tracked lost+found content in a clean checkout", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ork-ws-lost-found-"));
    try {
      const clone = join(workspace, ".orkestrator", ".clone-in-progress");
      mkdirSync(join(clone, "lost+found"), { recursive: true });
      writeFileSync(join(clone, "lost+found", "fixture.txt"), "tracked");
      const git = (...args: string[]) =>
        spawnSync("git", ["-C", clone, ...args], { encoding: "utf8" });
      expect(git("init").status).toBe(0);
      expect(git("add", ".").status).toBe(0);
      expect(
        git(
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "fixture",
        ).status,
      ).toBe(0);

      expect(runMove(clone, workspace).status).toBe(0);
      expect(readFileSync(join(workspace, "lost+found", "fixture.txt"), "utf8")).toBe("tracked");
      const status = spawnSync("git", ["-C", workspace, "diff", "--exit-code", "HEAD"], {
        encoding: "utf8",
      });
      expect(status.status).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("a filesystem lost+found collision fails without discarding repository content", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ork-ws-lost-found-"));
    try {
      const clone = stagedClone(workspace);
      mkdirSync(join(clone, "lost+found"));
      writeFileSync(join(clone, "lost+found", "fixture.txt"), "tracked");
      mkdirSync(join(workspace, "lost+found"));
      writeFileSync(join(workspace, "lost+found", "recovered"), "filesystem");
      expect(runMove(clone, workspace).status).not.toBe(0);
      expect(readFileSync(join(clone, "lost+found", "fixture.txt"), "utf8")).toBe("tracked");
      expect(readFileSync(join(workspace, "lost+found", "recovered"), "utf8")).toBe("filesystem");
      expect(existsSync(join(workspace, ".orkestrator", ".clone-copy-in-progress"))).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("workspace setup GitHub credential cleanup", () => {
  test.each(["", "current-token"])("removes legacy rewrites before clone (token %s)", (token) => {
    const root = mkdtempSync(join(tmpdir(), "ork-setup-credential-"));
    try {
      const config = join(root, "gitconfig");
      writeFileSync(
        config,
        `[url "https://x-access-token:legacy-secret@github.com/"]
  insteadOf = https://github.com/
[url "https://x-access-token:other-secret@github.com/"]
  insteadOf = git@github.com:
`,
      );
      const setup = readFileSync(setupScript, "utf8");
      const block = setup.slice(
        setup.indexOf("# Configure GitHub token"),
        setup.indexOf("print_workspace_disk_status()"),
      );
      const remoteLine = setup.split("\n").find((line) => line.includes('echo "  Remote:'))!;
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -e
${block}
git init -q .
git remote add origin https://github.com/example/repo.git
git remote get-url origin
${remoteLine}
git remote set-url origin https://user:embedded-secret@github.com/example/repo.git
${remoteLine}
cat "$GIT_CONFIG_GLOBAL"
`,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: config,
            GIT_CONFIG_NOSYSTEM: "1",
            GH_TOKEN: token,
            GITHUB_TOKEN: "",
          },
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("https://github.com/example/repo.git");
      expect(result.stdout).not.toContain("legacy-secret");
      expect(result.stdout).not.toContain("other-secret");
      expect(result.stdout).not.toContain("push-secret");
      expect(result.stdout).not.toContain("embedded-secret");
      expect(result.stdout).not.toContain("current-token");
      expect(readFileSync(config, "utf8")).not.toContain("x-access-token:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
