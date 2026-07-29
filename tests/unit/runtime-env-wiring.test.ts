import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = join(import.meta.dir, "..", "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "orkestrator-runtime-env-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runShell(
  script: string,
  env: Record<string, string>,
): { stdout: string; stderr: string; exitCode: number | null } {
  // entrypoint.sh is `#!/bin/bash` and its helpers use bash-only expansions.
  // Running these under `sh` passed on macOS (where /bin/sh is bash) but was a
  // hard `Bad substitution` under dash, so the guards below silently tested
  // nothing on Linux CI. Match the shell the scripts actually run under.
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", script],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

const CODEX_HELPER_SED =
  "/^log_progress() {/,/^}$/p; " +
  "/^codex_path_has_symlink() {/,/^}$/p; " +
  "/^codex_destination_path_has_symlink() {/,/^}$/p; " +
  "/^copy_codex_file() {/,/^}$/p; " +
  "/^copy_codex_directory() {/,/^}$/p";

function codexCopyHelperHarness(body: string): string {
  const entrypoint = join(repoRoot, "docker", "entrypoint.sh");
  // The copy helpers warn through log_progress, so the harness needs the real
  // helper plus a PROGRESS_FILE. Tests that care about the progress file pass
  // their own; the rest discard that half of the output.
  return `
set -e
eval "$(sed -n '${CODEX_HELPER_SED}' ${shellQuote(entrypoint)})"
PROGRESS_FILE="\${PROGRESS_FILE:-/dev/null}"
${body}
`;
}

describe("container runtime environment wiring", () => {
  test("Docker image includes the shared runtime environment helper", () => {
    const dockerfile = read("docker/Dockerfile");

    expect(dockerfile).toContain(
      "COPY docker/runtime-env.sh /usr/local/bin/orkestrator-runtime-env.sh",
    );
    expect(dockerfile).toContain(
      "/usr/local/bin/orkestrator-runtime-env.sh",
    );
  });

  test("workspace setup captures a whitelisted runtime environment snapshot", () => {
    const setup = read("docker/workspace-setup.sh");
    const helper = read("docker/runtime-env.sh");

    expect(setup).toContain("capture_runtime_env_snapshot");
    expect(setup).toContain("orkestrator_capture_runtime_env");
    expect(helper).toContain(
      "for name in PATH BUN_INSTALL CARGO_HOME GOPATH PNPM_HOME",
    );
    expect(helper).not.toContain("env >");
    expect(helper).not.toContain("printenv");
  });

  test("container setup disables host credential helpers and interactive git prompts", () => {
    const setup = read("docker/workspace-setup.sh");
    const entrypoint = read("docker/entrypoint.sh");

    expect(entrypoint).toContain("git config --global --replace-all credential.helper \"\"");
    expect(setup).toContain("git config --global --replace-all credential.helper \"\"");
    expect(setup).toContain("export GIT_TERMINAL_PROMPT=0");
  });

  test("container startup copies only bounded Codex configuration state", () => {
    const entrypoint = read("docker/entrypoint.sh");

    expect(entrypoint).toContain("copy_codex_file /codex-home");
    expect(entrypoint).toContain("copy_codex_directory /codex-home");
    for (const allowlistedFile of [
      "auth.json",
      "config.toml",
      "AGENTS.md",
      "hooks.json",
      "models_cache.json",
      ".codex-global-state.json",
      "cloud-config-bundle-cache.json",
      "cloud-requirements-cache.json",
    ]) {
      expect(entrypoint).toMatch(
        new RegExp(`^[ \\t]*${allowlistedFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\\\?$`, "m"),
      );
    }
    for (const allowlistedDirectory of [
      "rules",
      "skills",
      "prompts",
      "vendor_imports",
      "plugins/cache",
    ]) {
      expect(entrypoint).toMatch(
        new RegExp(`^[ \\t]*${allowlistedDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\\\?$`, "m"),
      );
    }
    expect(entrypoint).toContain("CODEX_COPY_MAX_FILE_BYTES");
    expect(entrypoint).toContain("CODEX_COPY_MAX_DIRECTORY_ENTRIES");
    expect(entrypoint).toContain("CODEX_COPY_MAX_DIRECTORY_KIB");
    expect(entrypoint).not.toContain("cp -r /codex-home/.");
    expect(entrypoint).not.toContain("cp -R /codex-home/.");

    for (const runtimeDirectory of [
      "sessions",
      "archived_sessions",
      "logs",
      "worktrees",
      "shell_snapshots",
      "generated_images",
      "computer-use",
      ".tmp",
      "plugins/.plugin-appserver",
    ]) {
      expect(entrypoint).not.toMatch(
        new RegExp(`^[ \\t]*${runtimeDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\\\?$`, "m"),
      );
    }
  });

  test("Codex configuration copy helpers overwrite changed inputs and merge repeatably", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      mkdirSync(join(source, "skills", "review"), { recursive: true });
      mkdirSync(join(source, "sessions"), { recursive: true });
      writeFileSync(join(source, "auth.json"), "{\"token\":\"test\"}\n");
      writeFileSync(join(source, "skills", "review", "SKILL.md"), "first\n");
      writeFileSync(join(source, "sessions", "rollout.jsonl"), "large runtime state\n");

      let result = runShell(
        codexCopyHelperHarness(`
copy_codex_file "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" auth.json
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" skills
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: destination,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(destination, "auth.json"), "utf8")).toBe("{\"token\":\"test\"}\n");
      expect(readFileSync(join(destination, "skills", "review", "SKILL.md"), "utf8")).toBe("first\n");
      expect(() => statSync(join(destination, "skills", "skills"))).toThrow();
      expect(() => statSync(join(destination, "sessions"))).toThrow();

      writeFileSync(join(source, "auth.json"), "{\"token\":\"changed\"}\n");
      writeFileSync(join(source, "skills", "review", "SKILL.md"), "changed\n");
      result = runShell(
        codexCopyHelperHarness(`
copy_codex_file "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" auth.json
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" skills
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: destination,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(readFileSync(join(destination, "auth.json"), "utf8")).toBe("{\"token\":\"changed\"}\n");
      expect(readFileSync(join(destination, "skills", "review", "SKILL.md"), "utf8")).toBe("changed\n");
    });
  });

  test("Codex configuration copy helpers skip missing and symlinked allowlist entries", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      mkdirSync(join(source, "sessions"), { recursive: true });
      writeFileSync(join(source, "sessions", "auth.json"), "excluded auth\n");
      writeFileSync(join(source, "sessions", "rollout.jsonl"), "excluded rollout\n");
      symlinkSync(join("sessions", "auth.json"), join(source, "auth.json"));
      symlinkSync("sessions", join(source, "skills"));

      const result = runShell(
        codexCopyHelperHarness(`
copy_codex_file "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" missing.toml
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" missing
copy_codex_file "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" auth.json
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" skills
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: destination,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Warning: Skipping symlinked Codex file: auth.json");
      expect(result.stdout).toContain("Warning: Skipping symlinked Codex directory: skills");
      expect(result.stdout).toEndWith("continued");
      expect(result.stdout).not.toContain("missing.toml");
      expect(() => statSync(join(destination, "auth.json"))).toThrow();
      expect(() => statSync(join(destination, "skills"))).toThrow();
      expect(() => statSync(join(destination, "sessions"))).toThrow();
    });
  });

  test("Codex directory copy rejects nested absolute symlinks to excluded state", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      const excludedSessions = join(source, "sessions");
      mkdirSync(join(source, "skills", "review"), { recursive: true });
      mkdirSync(excludedSessions, { recursive: true });
      writeFileSync(join(source, "skills", "review", "SKILL.md"), "safe skill\n");
      writeFileSync(join(excludedSessions, "rollout.jsonl"), "excluded rollout\n");
      symlinkSync(
        excludedSessions,
        join(source, "skills", "review", "host-sessions"),
      );

      const result = runShell(
        codexCopyHelperHarness(`
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" skills
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: destination,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "Warning: Skipping Codex directory containing symlink: skills",
      );
      expect(result.stdout).not.toContain(excludedSessions);
      expect(result.stdout).toEndWith("continued");
      expect(() => statSync(join(destination, "skills"))).toThrow();
      expect(() => statSync(join(destination, "sessions"))).toThrow();
    });
  });

  test("Codex configuration copy helpers reject symlinked parents of nested allowlist entries", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      mkdirSync(join(source, "sessions", "cache"), { recursive: true });
      writeFileSync(join(source, "sessions", "cache", "rollout.jsonl"), "excluded rollout\n");
      writeFileSync(join(source, "sessions", "config.toml"), "excluded config\n");
      // Only the "plugins" parent is a link; "cache" beneath it is a real
      // directory. A guard that inspects the final component alone walks
      // straight through this into the excluded session state.
      symlinkSync("sessions", join(source, "plugins"));

      const result = runShell(
        codexCopyHelperHarness(`
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" plugins/cache
copy_codex_file "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" plugins/config.toml
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: destination,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "Warning: Skipping symlinked Codex directory: plugins/cache",
      );
      expect(result.stdout).toContain(
        "Warning: Skipping symlinked Codex file: plugins/config.toml",
      );
      expect(result.stdout).toEndWith("continued");
      expect(() => statSync(destination)).toThrow();
    });
  });

  test("Codex configuration copy helpers reject destination root, parent, and file symlinks", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const external = join(dir, "external");
      mkdirSync(join(source, "plugins", "cache"), { recursive: true });
      mkdirSync(external);
      writeFileSync(join(source, "auth.json"), "host auth\n");
      writeFileSync(join(source, "config.toml"), "host root config\n");
      writeFileSync(join(source, "plugins", "config.toml"), "host config\n");
      writeFileSync(join(source, "plugins", "cache", "index.json"), "host cache\n");

      const rootLink = join(dir, "destination-root-link");
      symlinkSync(external, rootLink);
      const rootResult = runShell(
        codexCopyHelperHarness(`
copy_codex_file "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" auth.json
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: rootLink,
        },
      );
      expect(rootResult.exitCode).toBe(0);
      expect(rootResult.stdout).toContain(
        "Warning: Skipping Codex file with symlinked destination: auth.json",
      );
      expect(rootResult.stdout).toEndWith("continued");
      expect(() => statSync(join(external, "auth.json"))).toThrow();

      const parentDestination = join(dir, "parent-destination");
      const linkedParentTarget = join(dir, "linked-parent-target");
      mkdirSync(parentDestination);
      mkdirSync(linkedParentTarget);
      symlinkSync(linkedParentTarget, join(parentDestination, "plugins"));
      const parentResult = runShell(
        codexCopyHelperHarness(`
copy_codex_file "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" plugins/config.toml
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" plugins/cache
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: parentDestination,
        },
      );
      expect(parentResult.exitCode).toBe(0);
      expect(parentResult.stdout).toContain(
        "Warning: Skipping Codex file with symlinked destination: plugins/config.toml",
      );
      expect(parentResult.stdout).toContain(
        "Warning: Skipping Codex directory with symlinked destination: plugins/cache",
      );
      expect(parentResult.stdout).toEndWith("continued");
      expect(() => statSync(join(linkedParentTarget, "config.toml"))).toThrow();
      expect(() => statSync(join(linkedParentTarget, "cache"))).toThrow();

      const leafDestination = join(dir, "leaf-destination");
      const linkedAuthTarget = join(dir, "linked-auth-target");
      const linkedConfigTarget = join(dir, "linked-config-target");
      mkdirSync(leafDestination);
      writeFileSync(linkedAuthTarget, "workload data\n");
      writeFileSync(linkedConfigTarget, "workload config\n");
      symlinkSync(linkedAuthTarget, join(leafDestination, "auth.json"));
      symlinkSync(linkedConfigTarget, join(leafDestination, "config.toml"));
      const leafResult = runShell(
        codexCopyHelperHarness(`
copy_codex_file "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" auth.json
copy_codex_file "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" config.toml
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: leafDestination,
        },
      );
      expect(leafResult.exitCode).toBe(0);
      expect(leafResult.stdout).toContain(
        "Warning: Skipping Codex file with symlinked destination: auth.json",
      );
      expect(leafResult.stdout).toContain(
        "Warning: Skipping Codex file with symlinked destination: config.toml",
      );
      expect(leafResult.stdout).toEndWith("continued");
      expect(readFileSync(linkedAuthTarget, "utf8")).toBe("workload data\n");
      expect(readFileSync(linkedConfigTarget, "utf8")).toBe("workload config\n");
    });
  });

  test("Codex directory copy rejects symlinks nested inside an existing destination", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      const external = join(dir, "external");
      mkdirSync(join(source, "skills", "review"), { recursive: true });
      mkdirSync(join(destination, "skills"), { recursive: true });
      mkdirSync(external);
      writeFileSync(join(source, "skills", "review", "SKILL.md"), "host skill\n");
      writeFileSync(join(external, "preserved.txt"), "workload data\n");
      symlinkSync(external, join(destination, "skills", "review"));

      const result = runShell(
        codexCopyHelperHarness(`
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" skills
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: destination,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "Warning: Skipping Codex directory containing destination symlink: skills",
      );
      expect(result.stdout).toEndWith("continued");
      expect(readFileSync(join(external, "preserved.txt"), "utf8")).toBe("workload data\n");
      expect(() => statSync(join(external, "SKILL.md"))).toThrow();
    });
  });

  test("Codex configuration copy helpers enforce file and directory bounds", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      mkdirSync(join(source, "skills"), { recursive: true });
      writeFileSync(join(source, "config.toml"), "12345");
      writeFileSync(join(source, "skills", "one"), "1");
      writeFileSync(join(source, "skills", "two"), "2");

      const result = runShell(
        codexCopyHelperHarness(`
copy_codex_file "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" config.toml
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" skills
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: destination,
          CODEX_COPY_MAX_FILE_BYTES: "4",
          CODEX_COPY_MAX_DIRECTORY_ENTRIES: "1",
          CODEX_COPY_MAX_DIRECTORY_KIB: "1024",
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Warning: Skipping oversized Codex file: config.toml");
      expect(result.stdout).toContain("Warning: Skipping oversized Codex directory: skills");
      expect(result.stdout).toEndWith("continued");
      expect(() => statSync(join(destination, "config.toml"))).toThrow();
      expect(() => statSync(join(destination, "skills"))).toThrow();
    });
  });

  test("Codex directory entry inspection stops after the configured bound", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      const fakeBin = join(dir, "fake-bin");
      const visitLog = join(dir, "visited");
      const completionMarker = join(dir, "completed");
      mkdirSync(join(source, "skills"), { recursive: true });
      mkdirSync(fakeBin);
      for (let index = 0; index < 1000; index += 1) {
        writeFileSync(join(source, "skills", `entry-${index.toString().padStart(4, "0")}`), "x");
      }
      writeFileSync(
        join(fakeBin, "find"),
        `#!/bin/bash
for entry in "$CODEX_TEST_SOURCE"/skills/*; do
  if ! /usr/bin/printf '.'; then
    exit 141
  fi
  /usr/bin/printf '%s\\n' "$entry" >> "$CODEX_VISIT_LOG"
done
touch "$CODEX_COMPLETION_MARKER"
`,
      );
      chmodSync(join(fakeBin, "find"), 0o755);

      const result = runShell(
        codexCopyHelperHarness(`
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" skills
printf "continued"
`),
        {
          PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: destination,
          CODEX_COPY_MAX_DIRECTORY_ENTRIES: "3",
          CODEX_VISIT_LOG: visitLog,
          CODEX_COMPLETION_MARKER: completionMarker,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Warning: Skipping oversized Codex directory: skills");
      expect(result.stdout).toEndWith("continued");
      const visitedCount = readFileSync(visitLog, "utf8").trim().split("\n").length;
      expect(visitedCount).toBeLessThan(1000);
      expect(() => statSync(completionMarker)).toThrow();
      expect(() => statSync(join(destination, "skills"))).toThrow();
    });
  });

  test("Codex directory copy enforces the size cap independently of the entry cap", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      mkdirSync(join(source, "skills"), { recursive: true });
      writeFileSync(join(source, "skills", "big.bin"), "x".repeat(256 * 1024));

      const result = runShell(
        codexCopyHelperHarness(`
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" skills
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: destination,
          // Generous entry cap so only the size cap can reject this directory.
          CODEX_COPY_MAX_DIRECTORY_ENTRIES: "1000",
          CODEX_COPY_MAX_DIRECTORY_KIB: "8",
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Warning: Skipping oversized Codex directory: skills");
      expect(result.stdout).toEndWith("continued");
      expect(() => statSync(join(destination, "skills"))).toThrow();
    });
  });

  test("Codex directory copy counts entries robustly when a filename contains a newline", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      mkdirSync(join(source, "skills"), { recursive: true });
      writeFileSync(join(source, "skills", "plain.md"), "plain\n");
      writeFileSync(join(source, "skills", "new\nline.md"), "newline\n");

      const result = runShell(
        codexCopyHelperHarness(`
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" skills
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: destination,
          // Exactly the real entry count. A line-based count sees four.
          CODEX_COPY_MAX_DIRECTORY_ENTRIES: "2",
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("Warning");
      expect(result.stdout).toEndWith("continued");
      expect(readFileSync(join(destination, "skills", "plain.md"), "utf8")).toBe("plain\n");
      expect(readFileSync(join(destination, "skills", "new\nline.md"), "utf8")).toBe("newline\n");
    });
  });

  test("Codex configuration copy helpers fall back to defaults for non-numeric bounds", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      mkdirSync(join(source, "skills"), { recursive: true });
      writeFileSync(join(source, "config.toml"), "config\n");
      writeFileSync(join(source, "skills", "SKILL.md"), "skill\n");

      const result = runShell(
        codexCopyHelperHarness(`
copy_codex_file "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" config.toml
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" skills
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: destination,
          CODEX_COPY_MAX_FILE_BYTES: "not-a-number",
          CODEX_COPY_MAX_DIRECTORY_ENTRIES: "many",
          CODEX_COPY_MAX_DIRECTORY_KIB: "1e6",
        },
      );

      expect(result.exitCode).toBe(0);
      // Without the fallbacks the comparisons would be a `test` usage error, so
      // an empty stderr is what proves the defaults took effect.
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("Warning");
      expect(result.stdout).toEndWith("continued");
      expect(readFileSync(join(destination, "config.toml"), "utf8")).toBe("config\n");
      expect(readFileSync(join(destination, "skills", "SKILL.md"), "utf8")).toBe("skill\n");
    });
  });

  test("Codex configuration copy warnings reach the progress file the terminal replays", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      const progressFile = join(dir, "entrypoint-progress");
      mkdirSync(join(source, "sessions"), { recursive: true });
      writeFileSync(join(source, "sessions", "auth.json"), "excluded auth\n");
      symlinkSync(join("sessions", "auth.json"), join(source, "auth.json"));
      writeFileSync(progressFile, "");

      const result = runShell(
        codexCopyHelperHarness(`
copy_codex_file "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" auth.json
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: destination,
          PROGRESS_FILE: progressFile,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toEndWith("continued");
      const progress = readFileSync(progressFile, "utf8");
      expect(progress).toContain("Warning: Skipping symlinked Codex file: auth.json");
      expect(progress).not.toContain("excluded auth");
    });
  });

  test("Codex configuration copy failures warn and do not stop startup", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      mkdirSync(join(source, "skills"), { recursive: true });
      mkdirSync(destination);
      writeFileSync(join(source, "auth.json"), "auth\n");
      writeFileSync(join(source, "skills", "SKILL.md"), "skill\n");
      mkdirSync(join(destination, "auth.json"));
      writeFileSync(join(destination, "skills"), "destination conflict\n");

      const conflictResult = runShell(
        codexCopyHelperHarness(`
copy_codex_file "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" auth.json
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" skills
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: destination,
        },
      );

      expect(conflictResult.exitCode).toBe(0);
      expect(conflictResult.stdout).toContain("destination is a directory");
      expect(conflictResult.stdout).toContain("destination is not a directory");
      expect(conflictResult.stdout).toEndWith("continued");

      const blockedDestination = join(dir, "blocked-destination");
      writeFileSync(blockedDestination, "not a directory\n");
      const mkdirResult = runShell(
        codexCopyHelperHarness(`
copy_codex_file "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" auth.json
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" skills
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: blockedDestination,
        },
      );

      expect(mkdirResult.exitCode).toBe(0);
      expect(mkdirResult.stdout).toContain("Failed to create destination for Codex file: auth.json");
      expect(mkdirResult.stdout).toContain("Failed to create destination for Codex directory: skills");
      expect(mkdirResult.stdout).toEndWith("continued");

      const fakeBin = join(dir, "fake-bin");
      const copyFailureDestination = join(dir, "copy-failure-destination");
      mkdirSync(fakeBin);
      writeFileSync(join(fakeBin, "cp"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(fakeBin, "cp"), 0o755);
      const copyResult = runShell(
        codexCopyHelperHarness(`
copy_codex_file "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" auth.json
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" skills
printf "continued"
`),
        {
          PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: copyFailureDestination,
        },
      );

      expect(copyResult.exitCode).toBe(0);
      expect(copyResult.stdout).toContain("Warning: Failed to copy Codex file: auth.json");
      expect(copyResult.stdout).toContain("Warning: Failed to copy Codex directory: skills");
      expect(copyResult.stdout).toEndWith("continued");
    });
  });

  test("Codex configuration copy inspection failures warn and skip the entry", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      mkdirSync(join(source, "skills"), { recursive: true });
      writeFileSync(join(source, "auth.json"), "auth\n");
      writeFileSync(join(source, "skills", "SKILL.md"), "skill\n");

      // Shadow one real binary at a time so each inspection step fails on its
      // own; a partial `du` failure still prints a truncated total, so the size
      // cap has to be driven by the exit status rather than the output.
      function pathWithFake(name: string, script: string): string {
        const fakeBin = join(dir, `fake-${name}`);
        mkdirSync(fakeBin, { recursive: true });
        writeFileSync(join(fakeBin, name), script);
        chmodSync(join(fakeBin, name), 0o755);
        return `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
      }

      function run(name: string, script: string, destinationName: string) {
        const destination = join(dir, destinationName);
        const result = runShell(
          codexCopyHelperHarness(`
copy_codex_file "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" auth.json
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" skills
printf "continued"
`),
          {
            PATH: pathWithFake(name, script),
            CODEX_TEST_SOURCE: source,
            CODEX_TEST_DESTINATION: destination,
          },
        );
        return { result, destination };
      }

      const wcFailure = run("wc", "#!/bin/sh\nexit 1\n", "wc-destination");
      expect(wcFailure.result.exitCode).toBe(0);
      expect(wcFailure.result.stdout).toContain("Warning: Failed to inspect Codex file: auth.json");
      expect(wcFailure.result.stdout).toEndWith("continued");
      expect(() => statSync(join(wcFailure.destination, "auth.json"))).toThrow();

      const findFailure = run("find", "#!/bin/sh\nexit 1\n", "find-destination");
      expect(findFailure.result.exitCode).toBe(0);
      expect(findFailure.result.stdout).toContain(
        "Warning: Failed to inspect Codex directory: skills",
      );
      expect(() => statSync(join(findFailure.destination, "skills"))).toThrow();

      const duFailure = run("du", "#!/bin/sh\nexit 1\n", "du-destination");
      expect(duFailure.result.exitCode).toBe(0);
      expect(duFailure.result.stdout).toContain(
        "Warning: Failed to inspect Codex directory: skills",
      );
      expect(() => statSync(join(duFailure.destination, "skills"))).toThrow();

      const duNonNumericBin = join(dir, "fake-du-non-numeric");
      mkdirSync(duNonNumericBin, { recursive: true });
      writeFileSync(join(duNonNumericBin, "du"), "#!/bin/sh\nprintf 'unknown\\t%s\\n' \"$2\"\n");
      chmodSync(join(duNonNumericBin, "du"), 0o755);
      const nonNumericDestination = join(dir, "du-non-numeric-destination");
      const nonNumeric = runShell(
        codexCopyHelperHarness(`
copy_codex_directory "$CODEX_TEST_SOURCE" "$CODEX_TEST_DESTINATION" skills
printf "continued"
`),
        {
          PATH: `${duNonNumericBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          CODEX_TEST_SOURCE: source,
          CODEX_TEST_DESTINATION: nonNumericDestination,
        },
      );
      expect(nonNumeric.exitCode).toBe(0);
      expect(nonNumeric.stdout).toContain("Warning: Failed to inspect Codex directory: skills");
      expect(nonNumeric.stdout).toEndWith("continued");
      expect(() => statSync(join(nonNumericDestination, "skills"))).toThrow();
    });
  });

  test("Codex setup copies the complete allowlist, secures auth, and excludes plugin runtime state", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const home = join(dir, "home");
      const destination = join(home, ".codex");
      const files = [
        "auth.json",
        "config.toml",
        "AGENTS.md",
        "hooks.json",
        "models_cache.json",
        ".codex-global-state.json",
        "cloud-config-bundle-cache.json",
        "cloud-requirements-cache.json",
      ];
      const directories = ["rules", "skills", "prompts", "vendor_imports", "plugins/cache"];
      mkdirSync(source, { recursive: true });
      for (const file of files) {
        writeFileSync(join(source, file), `${file}\n`, { mode: 0o644 });
      }
      for (const directory of directories) {
        mkdirSync(join(source, directory), { recursive: true });
        writeFileSync(join(source, directory, "copied.txt"), `${directory}\n`);
      }
      mkdirSync(join(source, "plugins", ".plugin-appserver"), { recursive: true });
      writeFileSync(join(source, "plugins", ".plugin-appserver", "host-binary"), "excluded\n");
      mkdirSync(join(source, "sessions"), { recursive: true });
      writeFileSync(join(source, "sessions", "rollout.jsonl"), "excluded\n");

      const entrypoint = join(repoRoot, "docker", "entrypoint.sh");
      const result = runShell(
        `
set -e
log_progress() { :; }
eval "$(sed -n '/^codex_path_has_symlink() {/,/^}$/p; /^codex_destination_path_has_symlink() {/,/^}$/p; /^copy_codex_file() {/,/^}$/p; /^copy_codex_directory() {/,/^}$/p' ${shellQuote(entrypoint)})"
codex_setup="$(sed -n '/^# Set up Codex configuration$/,/^log_progress "Codex configuration ready"$/p' ${shellQuote(entrypoint)} | sed "s#/codex-home#\\$CODEX_TEST_SOURCE#g")"
eval "$codex_setup"
`,
        {
          HOME: home,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_TEST_SOURCE: source,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      for (const file of files) {
        expect(readFileSync(join(destination, file), "utf8")).toBe(`${file}\n`);
      }
      for (const directory of directories) {
        expect(readFileSync(join(destination, directory, "copied.txt"), "utf8")).toBe(`${directory}\n`);
      }
      expect(statSync(join(destination, "auth.json")).mode & 0o777).toBe(0o600);
      expect(() => statSync(join(destination, "plugins", ".plugin-appserver"))).toThrow();
      expect(() => statSync(join(destination, "sessions"))).toThrow();
    });
  });

  test("workspace setup exits early when a prior setup already completed", () => {
    const setup = read("docker/workspace-setup.sh");
    const completionGuard = setup.indexOf("if [ -f /tmp/.workspace-setup-complete ]; then");
    const cloneBlock = setup.indexOf("if [ -n \"$GIT_URL\" ] && [ ! -d \"/workspace/.git\" ]; then");

    expect(completionGuard).toBeGreaterThan(0);
    expect(cloneBlock).toBeGreaterThan(completionGuard);
    expect(setup).toContain("Workspace already set up.");
    expect(setup).toContain("exit 0");
  });

  test("container native launch paths source the captured runtime environment", () => {
    const backend = read("apps/backend/src/core/commands.ts");

    // Some launch paths inline the start script, others delegate to a shared
    // `*_START_COMMAND` constant. Resolve the constant body so the invariant is
    // enforced regardless of which form a given command uses.
    function startCommandConstant(name: string): string {
      const marker = `const ${name} = \``;
      const start = backend.indexOf(marker);
      expect(start).toBeGreaterThan(0);
      const bodyStart = start + marker.length;
      const end = backend.indexOf("`", bodyStart);
      expect(end).toBeGreaterThan(bodyStart);
      return backend.slice(bodyStart, end);
    }

    // Bridges that need an auth token delegate the whole start sequence to a
    // `startContainer*Server` helper, so the script lives there rather than in
    // the register block. Fold the helper body in the same way.
    function startHelperBody(name: string): string {
      const marker = `async function ${name}(`;
      const start = backend.indexOf(marker);
      expect(start).toBeGreaterThan(0);
      // Helpers are top-level, so the next top-level declaration ends the body.
      const nextDeclaration = backend
        .slice(start + 1)
        .search(/\n(?:async )?function \w+\(|\nconst \w+ = /);
      return nextDeclaration === -1
        ? backend.slice(start)
        : backend.slice(start, start + 1 + nextDeclaration);
    }

    const commands = [
      "start_opencode_server",
      "start_claude_server",
      "start_codex_server",
    ];

    for (const command of commands) {
      const start = backend.indexOf(`register("${command}"`);
      expect(start).toBeGreaterThan(0);
      // Bound the block at the next register(...) call, regardless of its
      // indentation, so these assertions can only be satisfied by THIS
      // command's block and never leak into a neighbouring one.
      const nextRegister = backend.slice(start + 1).search(/\n\s*register\(/);
      const registerBlock =
        nextRegister === -1
          ? backend.slice(start)
          : backend.slice(start, start + 1 + nextRegister);
      // If the block references a shared start-command constant or delegates to
      // a start helper, fold that body into the searchable text.
      const referencedConstant = registerBlock.match(/[A-Z0-9_]+_START_COMMAND/);
      const referencedHelper = registerBlock.match(/startContainer\w+Server/);
      let block = registerBlock;
      if (referencedConstant) {
        block += `\n${startCommandConstant(referencedConstant[0])}`;
      }
      if (referencedHelper) {
        block += `\n${startHelperBody(referencedHelper[0])}`;
      }
      expect(block).toContain("source /usr/local/bin/orkestrator-runtime-env.sh");
      expect(block).toContain("orkestrator_source_runtime_env");
    }
  });

  test("runtime helper prepends existing directories without duplicating PATH entries", () => {
    withTempDir((dir) => {
      const helper = join(repoRoot, "docker/runtime-env.sh");
      const home = join(dir, "home");
      const localBin = join(home, ".local", "bin");
      const bunBin = join(home, ".bun", "bin");
      mkdirSync(localBin, { recursive: true });
      mkdirSync(bunBin, { recursive: true });

      const result = runShell(
        `
          . ${shellQuote(helper)}
          PATH="/usr/bin:/bin"
          orkestrator_prepend_path ${shellQuote(localBin)}
          orkestrator_prepend_path ${shellQuote(localBin)}
          orkestrator_add_common_runtime_paths
          printf "%s" "$PATH"
        `,
        {
          HOME: home,
          PATH: "/usr/bin:/bin",
          ORKESTRATOR_RUNTIME_ENV_FILE: join(dir, "runtime-env.sh"),
          ORKESTRATOR_BASH_ENV_FILE: join(dir, "bash-env.sh"),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const entries = result.stdout.split(":");
      expect(entries.filter((entry) => entry === localBin)).toHaveLength(1);
      expect(entries.filter((entry) => entry === bunBin)).toHaveLength(1);
      expect(entries).toContain("/usr/bin");
      expect(entries).toContain("/bin");
    });
  });

  test("runtime helper captures and sources only whitelisted path variables", () => {
    withTempDir((dir) => {
      const helper = join(repoRoot, "docker/runtime-env.sh");
      const home = join(dir, "home");
      const snapshot = join(dir, "runtime-env.sh");
      const cargoHome = join(home, "cargo home's");
      const bunInstall = join(home, ".bun");
      mkdirSync(join(cargoHome, "bin"), { recursive: true });
      mkdirSync(join(bunInstall, "bin"), { recursive: true });

      const result = runShell(
        `
          . ${shellQuote(helper)}
          export CARGO_HOME=${shellQuote(cargoHome)}
          export BUN_INSTALL=${shellQuote(bunInstall)}
          export SECRET_TOKEN="do-not-capture"
          export PATH="/usr/bin:/bin"
          orkestrator_capture_runtime_env
          unset CARGO_HOME BUN_INSTALL SECRET_TOKEN
          export PATH="/usr/bin:/bin"
          orkestrator_source_runtime_env
          printf "cargo=%s\\nbun=%s\\npath=%s\\nsecret=%s\\n" "$CARGO_HOME" "$BUN_INSTALL" "$PATH" "\${SECRET_TOKEN:-}"
        `,
        {
          HOME: home,
          PATH: "/usr/bin:/bin",
          ORKESTRATOR_RUNTIME_ENV_FILE: snapshot,
          ORKESTRATOR_BASH_ENV_FILE: join(dir, "bash-env.sh"),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`cargo=${cargoHome}`);
      expect(result.stdout).toContain(`bun=${bunInstall}`);
      expect(result.stdout).toContain(`${cargoHome}/bin`);
      expect(result.stdout).toContain(`${bunInstall}/bin`);
      expect(result.stdout).toContain("secret=");

      const captured = readFileSync(snapshot, "utf8");
      expect(captured).toContain("# orkestrator-runtime-env: v2");
      expect(captured).toContain("orkestrator_append_path ");
      expect(captured).not.toContain("export PATH=");
      expect(captured).toContain('if [ -z "${CARGO_HOME:-}" ]; then');
      expect(captured).toContain("    export CARGO_HOME");
      expect(captured).toContain('if [ -z "${BUN_INSTALL:-}" ]; then');
      expect(captured).toContain("    export BUN_INSTALL");
      expect(captured).toContain('if [ -z "${BASH_ENV:-}" ]; then');
      expect(captured).toContain("    export BASH_ENV");
      expect(captured).not.toContain("SECRET_TOKEN");
      expect(captured).not.toContain("do-not-capture");
    });
  });

  test("runtime helper applies the backend-managed GitHub credential override", () => {
    withTempDir((dir) => {
      const helper = join(repoRoot, "docker/runtime-env.sh");
      const credentialFile = join(dir, "github-token");
      writeFileSync(credentialFile, "host-gh-token", { mode: 0o600 });

      const selected = runShell(
        `
          . ${shellQuote(helper)}
          export GITHUB_TOKEN="stale-container-token"
          export GH_TOKEN="stale-container-token"
          orkestrator_source_runtime_env
          printf "%s|%s" "$GITHUB_TOKEN" "$GH_TOKEN"
        `,
        {
          HOME: join(dir, "home"),
          PATH: "/usr/bin:/bin",
          ORKESTRATOR_RUNTIME_ENV_FILE: join(dir, "runtime-env.sh"),
          ORKESTRATOR_BASH_ENV_FILE: join(dir, "bash-env.sh"),
          ORKESTRATOR_GITHUB_CREDENTIAL_FILE: credentialFile,
        },
      );
      expect(selected.exitCode).toBe(0);
      expect(selected.stdout).toBe("host-gh-token|host-gh-token");

      writeFileSync(credentialFile, "", { mode: 0o600 });
      const cleared = runShell(
        `
          . ${shellQuote(helper)}
          export GITHUB_TOKEN="stale-container-token"
          export GH_TOKEN="stale-container-token"
          orkestrator_source_runtime_env
          printf "%s|%s" "\${GITHUB_TOKEN:-}" "\${GH_TOKEN:-}"
        `,
        {
          HOME: join(dir, "home"),
          PATH: "/usr/bin:/bin",
          ORKESTRATOR_RUNTIME_ENV_FILE: join(dir, "runtime-env.sh"),
          ORKESTRATOR_BASH_ENV_FILE: join(dir, "bash-env.sh"),
          ORKESTRATOR_GITHUB_CREDENTIAL_FILE: credentialFile,
        },
      );
      expect(cleared.exitCode).toBe(0);
      expect(cleared.stdout).toBe("|");
    });
  });

  test("runtime helper distinguishes a missing credential file from an unreadable authoritative file", () => {
    withTempDir((dir) => {
      const helper = join(repoRoot, "docker/runtime-env.sh");
      const credentialFile = join(dir, "github-token");
      const baseEnv = {
        HOME: join(dir, "home"),
        PATH: "/usr/bin:/bin",
        ORKESTRATOR_RUNTIME_ENV_FILE: join(dir, "runtime-env.sh"),
        ORKESTRATOR_BASH_ENV_FILE: join(dir, "bash-env.sh"),
        ORKESTRATOR_GITHUB_CREDENTIAL_FILE: credentialFile,
      };

      const missing = runShell(
        `
          . ${shellQuote(helper)}
          export GITHUB_TOKEN="inherited-token"
          export GH_TOKEN="inherited-token"
          orkestrator_source_runtime_env
          printf "%s|%s" "$GITHUB_TOKEN" "$GH_TOKEN"
        `,
        baseEnv,
      );
      expect(missing.exitCode).toBe(0);
      expect(missing.stdout).toBe("inherited-token|inherited-token");

      writeFileSync(credentialFile, "unreadable-token", { mode: 0o600 });
      const failingBin = join(dir, "failing-bin");
      mkdirSync(failingBin);
      writeFileSync(join(failingBin, "cat"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      const unreadable = runShell(
        `
          . ${shellQuote(helper)}
          export GITHUB_TOKEN="inherited-token"
          export GH_TOKEN="inherited-token"
          orkestrator_source_runtime_env
          printf "%s|%s" "\${GITHUB_TOKEN:-}" "\${GH_TOKEN:-}"
        `,
        { ...baseEnv, PATH: `${failingBin}:/usr/bin:/bin` },
      );
      expect(unreadable.exitCode).toBe(0);
      expect(unreadable.stdout).toBe("|");
      expect(unreadable.stderr).toBe("");
    });
  });

  test("runtime helper preserves caller PATH additions in non-interactive bash", () => {
    withTempDir((dir) => {
      const bashCheck = Bun.spawnSync({
        cmd: ["sh", "-c", "command -v bash"],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (bashCheck.exitCode !== 0) {
        return;
      }

      const helper = join(repoRoot, "docker/runtime-env.sh");
      const home = join(dir, "home");
      const snapshot = join(dir, "runtime-env.sh");
      const bashEnv = join(dir, "bash-env.sh");
      const callerBin = join(dir, "node_modules", ".bin");
      const fakebin = join(callerBin, "fakebin");
      const bunInstall = join(home, ".bun");
      const overrideBunInstall = join(dir, "override-bun");
      const oldBun = join(bunInstall, "bin", "bun");
      const overrideBun = join(overrideBunInstall, "bin", "bun");
      mkdirSync(callerBin, { recursive: true });
      mkdirSync(join(bunInstall, "bin"), { recursive: true });
      mkdirSync(join(overrideBunInstall, "bin"), { recursive: true });
      writeFileSync(fakebin, "#!/bin/sh\nprintf FOUND\n");
      writeFileSync(oldBun, "#!/bin/sh\nprintf OLD_BUN\n");
      writeFileSync(overrideBun, "#!/bin/sh\nprintf OVERRIDE_BUN\n");
      chmodSync(fakebin, 0o755);
      chmodSync(oldBun, 0o755);
      chmodSync(overrideBun, 0o755);
      writeFileSync(
        bashEnv,
        `. ${shellQuote(helper)} 2>/dev/null || true\norkestrator_source_runtime_env 2>/dev/null || true\n`,
      );

      const result = runShell(
        `
          . ${shellQuote(helper)}
          export BUN_INSTALL=${shellQuote(bunInstall)}
          export PATH="/usr/bin:/bin"
          orkestrator_capture_runtime_env
          CALLER_BIN=${shellQuote(callerBin)}
          export CALLER_BIN
          PATH="$CALLER_BIN:/usr/bin:/bin" BUN_INSTALL=${shellQuote(overrideBunInstall)} bash -c '
            first="\${PATH%%:*}"
            [ "$first" = "$CALLER_BIN" ] || { printf "first=%s\\n" "$first"; exit 22; }
            fakebin
            printf "\\nbun=%s\\n" "$BUN_INSTALL"
            command -v bun
            bun
          '
        `,
        {
          HOME: home,
          PATH: "/usr/bin:/bin",
          ORKESTRATOR_RUNTIME_ENV_FILE: snapshot,
          ORKESTRATOR_BASH_ENV_FILE: bashEnv,
          BASH_ENV: bashEnv,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        `FOUND\nbun=${overrideBunInstall}\n${overrideBun}\nOVERRIDE_BUN`,
      );
    });
  });

  test("runtime helper migrates old snapshots without clobbering caller PATH", () => {
    withTempDir((dir) => {
      const helper = join(repoRoot, "docker/runtime-env.sh");
      const snapshot = join(dir, "runtime-env.sh");
      const bashEnv = join(dir, "bash-env.sh");
      const callerBin = join(dir, "caller", "bin");
      const oldBin = join(dir, "old", "bin");
      const oldTool = join(oldBin, "old-tool");
      mkdirSync(callerBin, { recursive: true });
      mkdirSync(oldBin, { recursive: true });
      writeFileSync(oldTool, "#!/bin/sh\nprintf OLD\n");
      chmodSync(oldTool, 0o755);
      writeFileSync(
        snapshot,
        [
          "# Generated by Orkestrator. Do not edit.",
          `export PATH=${shellQuote(`${oldBin}:/usr/bin:/bin`)}`,
          `export BUN_INSTALL=${shellQuote(join(dir, "old-bun"))}`,
          "",
        ].join("\n"),
      );

      const result = runShell(
        `
          . ${shellQuote(helper)}
          CALLER_BIN=${shellQuote(callerBin)}
          export CALLER_BIN
          PATH="$CALLER_BIN:/usr/bin:/bin"
          BUN_INSTALL="/override-bun"
          export BUN_INSTALL
          orkestrator_source_runtime_env
          first="\${PATH%%:*}"
          [ "$first" = "$CALLER_BIN" ] || { printf "first=%s\\n" "$first"; exit 22; }
          command -v old-tool
          printf "bun=%s\\n" "$BUN_INSTALL"
        `,
        {
          HOME: join(dir, "home"),
          PATH: "/usr/bin:/bin",
          ORKESTRATOR_RUNTIME_ENV_FILE: snapshot,
          ORKESTRATOR_BASH_ENV_FILE: bashEnv,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`${oldTool}\nbun=/override-bun\n`);

      const migrated = readFileSync(snapshot, "utf8");
      expect(migrated).toContain("# orkestrator-runtime-env: v2");
      expect(migrated).not.toContain("export PATH=");
    });
  });

  test("runtime helper falls back to caller paths when legacy snapshot migration fails", () => {
    withTempDir((dir) => {
      const helper = join(repoRoot, "docker/runtime-env.sh");
      const snapshot = join(dir, "runtime-env.sh");
      const bashEnv = join(dir, "bash-env.sh");
      const bunInstall = join(dir, "override-bun");
      const bunPath = join(bunInstall, "bin", "bun");
      mkdirSync(join(bunInstall, "bin"), { recursive: true });
      writeFileSync(bunPath, "#!/bin/sh\nprintf FALLBACK_BUN\n");
      chmodSync(bunPath, 0o755);
      writeFileSync(snapshot, "if true; then\n");

      const result = runShell(
        `
          . ${shellQuote(helper)}
          BUN_INSTALL=${shellQuote(bunInstall)}
          export BUN_INSTALL
          PATH="/usr/bin:/bin"
          orkestrator_source_runtime_env
          command -v bun
          bun
        `,
        {
          HOME: join(dir, "home"),
          PATH: "/usr/bin:/bin",
          ORKESTRATOR_RUNTIME_ENV_FILE: snapshot,
          ORKESTRATOR_BASH_ENV_FILE: bashEnv,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`${bunPath}\nFALLBACK_BUN`);

      const snapshotContents = readFileSync(snapshot, "utf8");
      expect(snapshotContents).not.toContain("# orkestrator-runtime-env: v2");
    });
  });

  test("runtime helper creates a bash env file with expected contents and permissions", () => {
    withTempDir((dir) => {
      const helper = join(repoRoot, "docker/runtime-env.sh");
      const bashEnv = join(dir, "bash-env.sh");

      const result = runShell(
        `
          . ${shellQuote(helper)}
          orkestrator_source_runtime_env
          first="$BASH_ENV"
          orkestrator_source_runtime_env
          printf "%s\\n%s" "$first" "$BASH_ENV"
        `,
        {
          HOME: join(dir, "home"),
          PATH: "/usr/bin:/bin",
          ORKESTRATOR_RUNTIME_ENV_FILE: join(dir, "runtime-env.sh"),
          ORKESTRATOR_BASH_ENV_FILE: bashEnv,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`${bashEnv}\n${bashEnv}`);

      const contents = readFileSync(bashEnv, "utf8");
      expect(contents).toContain(". /usr/local/bin/orkestrator-runtime-env.sh");
      expect(contents).toContain("orkestrator_source_runtime_env");
      expect(statSync(bashEnv).mode & 0o777).toBe(0o644);
    });
  });

  test("runtime helper makes bash login commands restore captured PATH", () => {
    withTempDir((dir) => {
      const bashCheck = Bun.spawnSync({
        cmd: ["sh", "-c", "command -v bash"],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (bashCheck.exitCode !== 0) {
        return;
      }

      const helper = join(repoRoot, "docker/runtime-env.sh");
      const home = join(dir, "home");
      const bunBin = join(home, ".bun", "bin");
      const bunPath = join(bunBin, "bun");
      mkdirSync(bunBin, { recursive: true });
      writeFileSync(bunPath, "#!/bin/sh\nprintf bun\n");
      chmodSync(bunPath, 0o755);

      const result = runShell(
        `
          . ${shellQuote(helper)}
          export PATH="/usr/bin:/bin"
          orkestrator_source_runtime_env
          bash -lc 'command -v bun'
        `,
        {
          HOME: home,
          PATH: "/usr/bin:/bin",
          ORKESTRATOR_RUNTIME_ENV_FILE: join(dir, "runtime-env.sh"),
          ORKESTRATOR_BASH_ENV_FILE: join(dir, "bash-env.sh"),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe(bunPath);
    });
  });

  test("workspace setup shell pattern reloads zshrc PATH changes between setup steps", () => {
    withTempDir((dir) => {
      const zshCheck = Bun.spawnSync({
        cmd: ["sh", "-c", "command -v zsh"],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (zshCheck.exitCode !== 0) {
        return;
      }

      const helper = join(repoRoot, "docker/runtime-env.sh");
      const home = join(dir, "home");
      const toolHome = join(home, ".new-tool");
      const toolBin = join(toolHome, "bin");
      mkdirSync(toolBin, { recursive: true });
      const toolPath = join(toolBin, "new-tool");
      writeFileSync(toolPath, "#!/bin/sh\nprintf new-tool\n");
      chmodSync(toolPath, 0o755);
      writeFileSync(
        join(home, ".zshrc"),
        `export NEW_TOOL_HOME=${shellQuote(toolHome)}\nexport PATH="$NEW_TOOL_HOME/bin:$PATH"\n`,
      );

      const command = [
        `source ${shellQuote(helper)} 2>/dev/null || true`,
        "orkestrator_source_runtime_env 2>/dev/null || true",
        "source ~/.zshrc 2>/dev/null || true",
        "orkestrator_add_common_runtime_paths 2>/dev/null || true",
        "command -v new-tool",
      ].join("; ");

      const result = Bun.spawnSync({
        cmd: ["zsh", "-lc", command],
        env: {
          HOME: home,
          PATH: "/usr/bin:/bin",
          ORKESTRATOR_RUNTIME_ENV_FILE: join(dir, "runtime-env.sh"),
          ORKESTRATOR_BASH_ENV_FILE: join(dir, "bash-env.sh"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString().trim()).toBe(toolPath);
    });
  });
});
