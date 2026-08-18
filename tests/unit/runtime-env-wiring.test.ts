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

const AGENT_HELPER_SED =
  "/^log_progress() {/,/^}$/p; " +
  "/^agent_copy_warn() {/,/^}$/p; " +
  "/^report_agent_copy_skips() {/,/^}$/p; " +
  "/^agent_source_path_has_symlink() {/,/^}$/p; " +
  "/^agent_destination_path_has_symlink() {/,/^}$/p; " +
  "/^copy_agent_file() {/,/^}$/p; " +
  "/^copy_agent_directory() {/,/^}$/p; " +
  "/^copy_agent_directory_entries() {/,/^}$/p";

function agentCopyHelperHarness(body: string): string {
  const entrypoint = join(repoRoot, "docker", "entrypoint.sh");
  // The copy helpers warn through log_progress, so the harness needs the real
  // helper plus a PROGRESS_FILE. Tests that care about the progress file pass
  // their own; the rest discard that half of the output.
  return `
set -e
eval "$(sed -n '${AGENT_HELPER_SED}' ${shellQuote(entrypoint)})"
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
    expect(dockerfile).toContain("/usr/local/bin/orkestrator-runtime-env.sh");
  });

  test("workspace setup captures a whitelisted runtime environment snapshot", () => {
    const setup = read("docker/workspace-setup.sh");
    const helper = read("docker/runtime-env.sh");

    expect(setup).toContain("capture_runtime_env_snapshot");
    expect(setup).toContain("orkestrator_capture_runtime_env");
    expect(helper).toContain("for name in PATH BUN_INSTALL CARGO_HOME GOPATH PNPM_HOME");
    expect(helper).not.toContain("env >");
    expect(helper).not.toContain("printenv");
  });

  test("container setup disables host credential helpers and interactive git prompts", () => {
    const setup = read("docker/workspace-setup.sh");
    const entrypoint = read("docker/entrypoint.sh");

    expect(entrypoint).toContain('git config --global --replace-all credential.helper ""');
    expect(setup).toContain('git config --global --replace-all credential.helper ""');
    expect(setup).toContain("export GIT_TERMINAL_PROMPT=0");
  });

  test("container startup copies only bounded Codex configuration state", () => {
    const entrypoint = read("docker/entrypoint.sh");

    expect(entrypoint).toContain("copy_agent_file /codex-home");
    expect(entrypoint).toContain("copy_agent_directory /codex-home");
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
        new RegExp(
          `^[ \\t]*${allowlistedFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\\\?$`,
          "m",
        ),
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
        new RegExp(
          `^[ \\t]*${allowlistedDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\\\?$`,
          "m",
        ),
      );
    }
    expect(entrypoint).toContain("AGENT_COPY_MAX_FILE_BYTES");
    expect(entrypoint).toContain("AGENT_COPY_MAX_DIRECTORY_ENTRIES");
    expect(entrypoint).toContain("AGENT_COPY_MAX_DIRECTORY_KIB");
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
        new RegExp(
          `^[ \\t]*${runtimeDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\\\?$`,
          "m",
        ),
      );
    }
  });

  test("every agent copies host state through the shared bounded helpers", () => {
    const entrypoint = read("docker/entrypoint.sh");

    // One mechanism for every agent. An unguarded `find -maxdepth 1 -type f`
    // or a bare recursive `cp` of a mounted home is what these helpers replaced;
    // none of them should reappear for any agent.
    for (const mount of [
      "/claude-config",
      "/codex-home",
      "/opencode-data",
      "/cursor-config",
      "/grok-home",
    ]) {
      expect(entrypoint).toContain(`copy_agent_file ${mount}`);
      expect(entrypoint).not.toContain(`find ${mount} -maxdepth 1 -type f`);
      expect(entrypoint).not.toContain(`cp -r ${mount}/.`);
      expect(entrypoint).not.toContain(`cp -R ${mount}/.`);
    }
    // Codex keeps the strict whole-directory copy for its platform-binary-heavy
    // dirs; Claude and OpenCode user-authored directories copy per-entry so a
    // single symlinked or oversized entry cannot drop the whole directory.
    expect(entrypoint).toContain("copy_agent_directory /codex-home");
    expect(entrypoint).toContain("copy_agent_directory_entries /claude-config");
    expect(entrypoint).toContain("copy_agent_directory_entries /opencode-data");
    expect(entrypoint).toContain("copy_agent_directory_entries /cursor-config");
    expect(entrypoint).toContain("copy_agent_directory_entries /grok-home");
    expect(entrypoint).toContain("copy_agent_directory /grok-config");
    // Each call site names its agent so a skipped file is attributable.
    for (const label of ["Claude", "Codex", "OpenCode", "Cursor", "Grok"]) {
      expect(entrypoint).toMatch(
        new RegExp(`copy_agent_(file|directory) [^\\n]*\\s${label}$`, "m"),
      );
    }
  });

  test("Cursor and Grok host state mounts do not replace their writable container homes", () => {
    const backend = read("apps/backend/src/core/commands-containers.ts");

    expect(backend).toContain('path.join(cursorHome, ".cursor"), "/cursor-config"');
    expect(backend).toContain('path.join(grokHome, ".grok"), "/grok-home"');
    expect(backend).toContain('path.join(grokHome, ".config", "grok"), "/grok-config"');
    expect(backend).not.toContain('path.join(home, ".cursor"), "/home/node/.cursor"');
    expect(backend).not.toContain('path.join(home, ".grok"), "/home/node/.grok"');
  });

  test("container startup copies only bounded Claude configuration state", () => {
    const entrypoint = read("docker/entrypoint.sh");

    for (const allowlisted of [
      "CLAUDE.md",
      "settings.local.json",
      "commands",
      "agents",
      "ide",
      "plugins",
    ]) {
      expect(entrypoint).toMatch(
        new RegExp(
          `^[ \\t]*${allowlisted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\\\?$`,
          "m",
        ),
      );
    }
    // history.jsonl is the host's rolling prompt history, including pasted
    // content, across every project. The old unbounded top-level file copy swept
    // it into every container; it must never be allowlisted back in.
    for (const excluded of [
      "history.jsonl",
      "daemon.log",
      "stats-cache.json",
      "projects",
      "jobs",
      "file-history",
    ]) {
      expect(entrypoint).not.toMatch(
        new RegExp(`^[ \\t]*${excluded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\\\?$`, "m"),
      );
    }
    // settings.json is rewritten below with the container's bypass-permissions
    // settings, so copying the host copy first was immediately discarded.
    expect(entrypoint).toContain('cat > "$HOME/.claude/settings.json"');
    expect(entrypoint).not.toMatch(/^[ \t]*settings\.json[ \t]*\\?$/m);
  });

  test("Claude data copy takes config and skips host history", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      mkdirSync(join(source, "commands"), { recursive: true });
      mkdirSync(join(source, "projects"), { recursive: true });
      writeFileSync(join(source, "CLAUDE.md"), "global instructions\n");
      writeFileSync(join(source, "settings.local.json"), '{"local":true}\n');
      writeFileSync(join(source, "history.jsonl"), '{"display":"secret prompt"}\n');
      writeFileSync(join(source, "daemon.log"), "log\n");
      writeFileSync(join(source, "stats-cache.json"), "{}\n");
      writeFileSync(join(source, "commands", "kept.md"), "kept\n");
      writeFileSync(join(source, "projects", "host.jsonl"), "host state\n");

      const result = runShell(
        agentCopyHelperHarness(`
for file in CLAUDE.md settings.local.json; do
  copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" "$file" Claude
done
for dir in commands agents ide plugins; do
  copy_agent_directory_entries "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" "$dir" Claude
done
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(destination, "CLAUDE.md"), "utf8")).toBe("global instructions\n");
      expect(readFileSync(join(destination, "settings.local.json"), "utf8")).toBe(
        '{"local":true}\n',
      );
      expect(readFileSync(join(destination, "commands", "kept.md"), "utf8")).toBe("kept\n");

      for (const excluded of ["history.jsonl", "daemon.log", "stats-cache.json", "projects"]) {
        expect(() => statSync(join(destination, excluded))).toThrow();
      }
    });
  });

  test("Claude copy refuses a symlinked host directory and a planted destination link", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      const outside = join(dir, "outside");
      mkdirSync(outside, { recursive: true });
      mkdirSync(destination, { recursive: true });
      mkdirSync(source, { recursive: true });
      writeFileSync(join(outside, "leaked.txt"), "host data outside the tree\n");
      // A dotfile manager symlinking ~/.claude/commands into a dotfiles repo is
      // ordinary; a plain `cp -r` followed it straight out of the mounted tree.
      symlinkSync(outside, join(source, "commands"));
      writeFileSync(join(source, "CLAUDE.md"), "real\n");
      // A previous workload in a reused container can plant this; plain `cp`
      // wrote through it.
      const plantedTarget = join(dir, "planted-target");
      writeFileSync(plantedTarget, "original\n");
      symlinkSync(plantedTarget, join(destination, "CLAUDE.md"));

      const result = runShell(
        agentCopyHelperHarness(`
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" commands Claude
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" CLAUDE.md Claude
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Warning: Skipping symlinked Claude directory: commands");
      expect(result.stdout).toContain(
        "Warning: Skipping Claude file with symlinked destination: CLAUDE.md",
      );
      expect(() => statSync(join(destination, "commands", "leaked.txt"))).toThrow();
      expect(readFileSync(plantedTarget, "utf8")).toBe("original\n");
    });
  });

  test("one symlinked command no longer drops the whole commands directory", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      const outside = join(dir, "outside");
      mkdirSync(join(source, "commands"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "secret.md"), "host content outside the tree\n");
      writeFileSync(join(source, "commands", "kept.md"), "kept\n");
      writeFileSync(join(source, "commands", "second.md"), "second\n");
      // A dotfile manager symlinking one command into the repo is ordinary. The
      // whole-directory helper used to reject the entire `commands` dir over
      // this single link; the per-entry walker must skip just the link.
      symlinkSync(join(outside, "secret.md"), join(source, "commands", "linked.md"));

      const result = runShell(
        agentCopyHelperHarness(`
copy_agent_directory_entries "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" commands Claude
report_agent_copy_skips Claude
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Skipping symlinked Claude entry: commands/linked.md");
      // The real commands survive.
      expect(readFileSync(join(destination, "commands", "kept.md"), "utf8")).toBe("kept\n");
      expect(readFileSync(join(destination, "commands", "second.md"), "utf8")).toBe("second\n");
      // The link is skipped, not followed, so no host content escapes the mount.
      expect(() => statSync(join(destination, "commands", "linked.md"))).toThrow();
      expect(() => statSync(join(destination, "commands", "secret.md"))).toThrow();
      // The consolidated summary names the skipped entry so it is not silent.
      expect(result.stdout).toContain("commands/linked.md");
    });
  });

  test("an oversized or symlinked subdirectory is skipped on its own, not the whole tree", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      const outside = join(dir, "outside");
      mkdirSync(join(source, "storage", "kept"), { recursive: true });
      mkdirSync(join(source, "storage", "huge"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(source, "storage", "kept", "a.json"), "kept\n");
      writeFileSync(join(outside, "b.json"), "outside\n");
      // A symlinked plugin record inside the storage tree.
      symlinkSync(outside, join(source, "storage", "linked"));
      // A subdirectory that exceeds the per-directory entry cap.
      for (let index = 0; index < 6; index += 1) {
        writeFileSync(join(source, "storage", "huge", `entry-${index}`), "x\n");
      }

      const result = runShell(
        agentCopyHelperHarness(`
AGENT_COPY_MAX_DIRECTORY_ENTRIES=3
copy_agent_directory_entries "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" storage OpenCode
report_agent_copy_skips OpenCode
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
        },
      );

      expect(result.exitCode).toBe(0);
      // The sibling that is portable still lands.
      expect(readFileSync(join(destination, "storage", "kept", "a.json"), "utf8")).toBe("kept\n");
      // The symlinked subdirectory is skipped as an entry, never followed.
      expect(result.stdout).toContain("Skipping symlinked OpenCode entry: storage/linked");
      expect(() => statSync(join(destination, "storage", "linked", "b.json"))).toThrow();
      // The oversized subdirectory is skipped on its own.
      expect(result.stdout).toContain("Skipping oversized OpenCode directory: storage/huge");
      expect(() => statSync(join(destination, "storage", "huge"))).toThrow();
      // Both are named in the consolidated summary.
      expect(result.stdout).toContain("storage/linked");
      expect(result.stdout).toContain("storage/huge");
    });
  });

  describe("Claude credential resolution inside the container", () => {
    // Nothing orders the entrypoint against the backend's `docker exec` sync;
    // they run concurrently. Extract the real block and drive each ordering.
    function runCredentialBlock(
      dir: string,
      options: { mount?: string; existing?: string; envValue?: string },
    ): { stdout: string; exitCode: number | null; credential: string | null } {
      const home = join(dir, "home");
      const mount = join(dir, "claude-config");
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(mount, { recursive: true });
      if (options.mount !== undefined) {
        writeFileSync(join(mount, ".credentials.json"), options.mount);
      }
      if (options.existing !== undefined) {
        writeFileSync(join(home, ".claude", ".credentials.json"), options.existing);
      }

      const entrypointPath = join(repoRoot, "docker", "entrypoint.sh");
      const result = runShell(
        `
set -e
block="$(sed -n '/^if \\[ -n "\\$CLAUDE_OAUTH_CREDENTIALS" \\]/,/^fi$/p' ${shellQuote(entrypointPath)} | sed "s#/claude-config#\\$AGENT_TEST_MOUNT#g")"
[ -n "$block" ] || { echo "harness failed to extract the credential block"; exit 9; }
log_progress() { echo "$1"; }
eval "$block"
`,
        {
          HOME: home,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_MOUNT: mount,
          ...(options.envValue === undefined ? {} : { CLAUDE_OAUTH_CREDENTIALS: options.envValue }),
        },
      );

      let credential: string | null = null;
      try {
        credential = readFileSync(join(home, ".claude", ".credentials.json"), "utf8");
      } catch {
        credential = null;
      }
      return { stdout: result.stdout, exitCode: result.exitCode, credential };
    }

    test("leaves a credential the backend already synced in place", () => {
      withTempDir((dir) => {
        // On macOS the backend prefers the Keychain, so the mounted copy is the
        // weaker source. Letting it win reproduces the "Not logged in" symptom
        // this whole path exists to fix.
        const result = runCredentialBlock(dir, {
          existing: '{"claudeAiOauth":{"accessToken":"fresh-from-keychain"}}',
          mount: '{"claudeAiOauth":{"accessToken":"stale-on-disk"}}',
        });

        expect(result.exitCode).toBe(0);
        expect(result.credential).toContain("fresh-from-keychain");
        expect(result.credential).not.toContain("stale-on-disk");
        expect(result.stdout).toContain("Credential already present");
      });
    });

    test("copies the mounted credential when the sync has not landed yet", () => {
      withTempDir((dir) => {
        // Linux hosts keep the credential on disk, so the mount is the only
        // source; the entrypoint must still work when it wins the race.
        const result = runCredentialBlock(dir, {
          mount: '{"claudeAiOauth":{"accessToken":"from-mount"}}',
        });

        expect(result.exitCode).toBe(0);
        expect(result.credential).toContain("from-mount");
        expect(result.stdout).toContain("Copied credentials from host");
      });
    });

    test("treats an empty pre-existing credential as absent", () => {
      withTempDir((dir) => {
        // A zero-byte file is a failed write, not a login. `-s` is what makes
        // this differ from `-f`, which would strand the container logged out.
        const result = runCredentialBlock(dir, {
          existing: "",
          mount: '{"claudeAiOauth":{"accessToken":"from-mount"}}',
        });

        expect(result.exitCode).toBe(0);
        expect(result.credential).toContain("from-mount");
      });
    });

    test("reports when neither the mount nor the sync has provided anything", () => {
      withTempDir((dir) => {
        const result = runCredentialBlock(dir, {});

        expect(result.exitCode).toBe(0);
        expect(result.credential).toBeNull();
        expect(result.stdout).toContain("awaiting the backend credential sync");
      });
    });

    test("an explicit CLAUDE_OAUTH_CREDENTIALS still overrides both sources", () => {
      withTempDir((dir) => {
        const result = runCredentialBlock(dir, {
          envValue: '{"claudeAiOauth":{"accessToken":"from-env"}}',
          existing: '{"claudeAiOauth":{"accessToken":"already-synced"}}',
          mount: '{"claudeAiOauth":{"accessToken":"from-mount"}}',
        });

        expect(result.exitCode).toBe(0);
        expect(result.credential).toContain("from-env");
      });
    });
  });

  test("container startup copies only bounded OpenCode state", () => {
    const entrypoint = read("docker/entrypoint.sh");

    // `find /opencode-data -maxdepth 1 -type f` copied every top-level file,
    // which meant the host's multi-GB opencode.db session database (plus its
    // -wal/-shm siblings) was copied into every container on every start.
    expect(entrypoint).not.toContain("find /opencode-data -maxdepth 1 -type f");
    expect(entrypoint).toContain("copy_agent_file /opencode-data");
    expect(entrypoint).toContain("copy_agent_directory_entries /opencode-data");

    for (const allowlisted of ["auth.json", "account.json", "storage", "snapshot"]) {
      expect(entrypoint).toMatch(
        new RegExp(
          `^[ \\t]*${allowlisted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\\\?$`,
          "m",
        ),
      );
    }
    for (const excluded of ["opencode.db", "opencode.db-wal", "opencode.db-shm"]) {
      expect(entrypoint).not.toMatch(
        new RegExp(`^[ \\t]*${excluded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\\\?$`, "m"),
      );
    }

    // node_modules under the config directory holds bun-installed plugin
    // dependencies built for the host platform; Mach-O binaries from a macOS
    // host cannot run in the Linux container.
    expect(entrypoint).not.toContain("cp -r /opencode-config/.");
    expect(entrypoint).toContain("OpenCode node_modules");
    expect(entrypoint).toContain('local excluded_entry="${5:-}"');
  });

  test("OpenCode config copy merges user-authored entries and drops node_modules", () => {
    withTempDir((dir) => {
      const source = join(dir, "opencode-config");
      const destination = join(dir, "destination");
      mkdirSync(join(source, "plugin"), { recursive: true });
      mkdirSync(join(source, "node_modules", "some-dep"), { recursive: true });
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(source, "opencode.json"), '{"config":true}\n');
      writeFileSync(join(source, ".hidden"), "dotfiles are user-authored too\n");
      writeFileSync(join(source, "plugin", "custom.ts"), "export default {}\n");
      writeFileSync(join(source, "node_modules", "some-dep", "binary.node"), "mach-o\n");

      const harness = agentCopyHelperHarness(`
copy_agent_directory_entries \
    "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" "." OpenCode node_modules
# Re-running is the container-restart path: the entrypoint runs on every start.
copy_agent_directory_entries \
    "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" "." OpenCode node_modules
printf 'continued'
`);

      const result = runShell(harness, {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        AGENT_TEST_SOURCE: source,
        AGENT_TEST_DESTINATION: destination,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("continued");
      expect(readFileSync(join(destination, "opencode.json"), "utf8")).toBe('{"config":true}\n');
      // `-mindepth 1` without `-name '.*'` handling would silently drop dotfiles.
      expect(readFileSync(join(destination, ".hidden"), "utf8")).toBe(
        "dotfiles are user-authored too\n",
      );
      // A second start must merge into the existing directory, not nest a copy
      // inside it or fail outright.
      expect(readFileSync(join(destination, "plugin", "custom.ts"), "utf8")).toBe(
        "export default {}\n",
      );
      expect(() => statSync(join(destination, "plugin", "plugin"))).toThrow();
      // Mach-O dependencies from a macOS host cannot run in the Linux container.
      expect(() => statSync(join(destination, "node_modules"))).toThrow();
    });
  });

  test("OpenCode data copy takes the credential and skips the session database", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      mkdirSync(join(source, "storage"), { recursive: true });
      mkdirSync(join(source, "snapshot"), { recursive: true });
      mkdirSync(join(source, "log"), { recursive: true });
      writeFileSync(join(source, "auth.json"), '{"token":"opencode"}\n', { mode: 0o600 });
      writeFileSync(join(source, "account.json"), '{"account":"test"}\n');
      writeFileSync(join(source, "opencode.db"), "x".repeat(1024 * 1024));
      writeFileSync(join(source, "opencode.db-wal"), "wal");
      writeFileSync(join(source, "opencode.db-shm"), "shm");
      writeFileSync(join(source, "storage", "kept.json"), "kept\n");
      writeFileSync(join(source, "snapshot", "kept.json"), "kept\n");
      writeFileSync(join(source, "log", "huge.log"), "runtime log\n");

      const result = runShell(
        agentCopyHelperHarness(`
for file in auth.json account.json; do
  copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" "$file" OpenCode
done
for dir in storage snapshot; do
  copy_agent_directory_entries "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" "$dir" OpenCode
done
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
        },
      );

      expect(result.exitCode).toBe(0);
      // OpenCode's credential is a plain file, so unlike Claude it rides the
      // existing mount — this is what keeps container OpenCode logged in.
      expect(readFileSync(join(destination, "auth.json"), "utf8")).toBe('{"token":"opencode"}\n');
      expect(readFileSync(join(destination, "account.json"), "utf8")).toBe('{"account":"test"}\n');
      expect(readFileSync(join(destination, "storage", "kept.json"), "utf8")).toBe("kept\n");
      expect(readFileSync(join(destination, "snapshot", "kept.json"), "utf8")).toBe("kept\n");

      for (const excluded of ["opencode.db", "opencode.db-wal", "opencode.db-shm", "log"]) {
        expect(() => statSync(join(destination, excluded))).toThrow();
      }
    });
  });

  test("OpenCode copy warnings name OpenCode rather than Codex", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "real.json"), "{}\n");
      symlinkSync(join(source, "real.json"), join(source, "auth.json"));

      const result = runShell(
        agentCopyHelperHarness(`
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" auth.json OpenCode
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Warning: Skipping symlinked OpenCode file: auth.json");
      expect(result.stdout).not.toContain("Codex");
    });
  });

  test("each agent block ends with a consolidated list of what it did not copy", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      const outside = join(dir, "outside");
      mkdirSync(join(outside, "real"), { recursive: true });
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "CLAUDE.md"), "kept\n");
      symlinkSync(outside, join(source, "commands"));
      symlinkSync(join(outside, "real"), join(source, "agents"));

      const result = runShell(
        agentCopyHelperHarness(`
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" CLAUDE.md Claude
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" commands Claude
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" agents Claude
report_agent_copy_skips Claude
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
        },
      );

      expect(result.exitCode).toBe(0);
      // An individual warning scrolls past in a wall of setup output; losing
      // your custom commands is not something to discover three prompts later.
      expect(result.stdout).toContain(
        "Claude host config NOT copied into this container: commands, agents",
      );
      // What did copy is not named in the summary.
      expect(result.stdout).not.toContain("CLAUDE.md, ");
      expect(readFileSync(join(destination, "CLAUDE.md"), "utf8")).toBe("kept\n");
    });
  });

  test("the skip summary stays silent when everything copied, and does not leak between agents", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      const outside = join(dir, "outside");
      mkdirSync(outside, { recursive: true });
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "CLAUDE.md"), "kept\n");
      symlinkSync(outside, join(source, "commands"));

      const result = runShell(
        agentCopyHelperHarness(`
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" commands Claude
report_agent_copy_skips Claude
printf -- '--- next agent ---\\n'
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" CLAUDE.md Codex
report_agent_copy_skips Codex
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
        },
      );

      expect(result.exitCode).toBe(0);
      const [claudePhase, codexPhase] = result.stdout.split("--- next agent ---");
      expect(claudePhase).toContain("Claude host config NOT copied");
      // Reporting Claude's skip again under Codex's name would be worse than
      // saying nothing: it accuses the wrong agent of losing state.
      expect(codexPhase).not.toContain("NOT copied");
    });
  });

  test("Codex configuration copy helpers overwrite changed inputs and merge repeatably", () => {
    withTempDir((dir) => {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      mkdirSync(join(source, "skills", "review"), { recursive: true });
      mkdirSync(join(source, "sessions"), { recursive: true });
      writeFileSync(join(source, "auth.json"), '{"token":"test"}\n');
      writeFileSync(join(source, "skills", "review", "SKILL.md"), "first\n");
      writeFileSync(join(source, "sessions", "rollout.jsonl"), "large runtime state\n");

      let result = runShell(
        agentCopyHelperHarness(`
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" auth.json Codex
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" skills Codex
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(destination, "auth.json"), "utf8")).toBe('{"token":"test"}\n');
      expect(readFileSync(join(destination, "skills", "review", "SKILL.md"), "utf8")).toBe(
        "first\n",
      );
      expect(() => statSync(join(destination, "skills", "skills"))).toThrow();
      expect(() => statSync(join(destination, "sessions"))).toThrow();

      writeFileSync(join(source, "auth.json"), '{"token":"changed"}\n');
      writeFileSync(join(source, "skills", "review", "SKILL.md"), "changed\n");
      result = runShell(
        agentCopyHelperHarness(`
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" auth.json Codex
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" skills Codex
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(readFileSync(join(destination, "auth.json"), "utf8")).toBe('{"token":"changed"}\n');
      expect(readFileSync(join(destination, "skills", "review", "SKILL.md"), "utf8")).toBe(
        "changed\n",
      );
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
        agentCopyHelperHarness(`
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" missing.toml Codex
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" missing Codex
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" auth.json Codex
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" skills Codex
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
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
      symlinkSync(excludedSessions, join(source, "skills", "review", "host-sessions"));

      const result = runShell(
        agentCopyHelperHarness(`
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" skills Codex
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
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
        agentCopyHelperHarness(`
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" plugins/cache Codex
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" plugins/config.toml Codex
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Warning: Skipping symlinked Codex directory: plugins/cache");
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
        agentCopyHelperHarness(`
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" auth.json Codex
printf "root-continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: rootLink,
        },
      );
      expect(rootResult.exitCode).toBe(0);
      expect(rootResult.stdout).toContain(
        "Warning: Skipping Codex file with symlinked destination: auth.json",
      );
      expect(rootResult.stdout).toContain("root-continued");
      expect(() => statSync(join(external, "auth.json"))).toThrow();

      const parentDestination = join(dir, "parent-destination");
      const linkedParentTarget = join(dir, "linked-parent-target");
      mkdirSync(parentDestination);
      mkdirSync(linkedParentTarget);
      symlinkSync(linkedParentTarget, join(parentDestination, "plugins"));
      const parentResult = runShell(
        agentCopyHelperHarness(`
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" plugins/config.toml Codex
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" plugins/cache Codex
printf "parent-continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: parentDestination,
        },
      );
      expect(parentResult.exitCode).toBe(0);
      expect(parentResult.stdout).toContain(
        "Warning: Skipping Codex file with symlinked destination: plugins/config.toml",
      );
      expect(parentResult.stdout).toContain(
        "Warning: Skipping Codex directory with symlinked destination: plugins/cache",
      );
      expect(parentResult.stdout).toContain("parent-continued");
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
        agentCopyHelperHarness(`
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" auth.json Codex
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" config.toml Codex
printf "leaf-continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: leafDestination,
        },
      );
      expect(leafResult.exitCode).toBe(0);
      expect(leafResult.stdout).toContain(
        "Warning: Skipping Codex file with symlinked destination: auth.json",
      );
      expect(leafResult.stdout).toContain(
        "Warning: Skipping Codex file with symlinked destination: config.toml",
      );
      expect(leafResult.stdout).toContain("leaf-continued");
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
        agentCopyHelperHarness(`
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" skills Codex
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
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
        agentCopyHelperHarness(`
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" config.toml Codex
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" skills Codex
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
          AGENT_COPY_MAX_FILE_BYTES: "4",
          AGENT_COPY_MAX_DIRECTORY_ENTRIES: "1",
          AGENT_COPY_MAX_DIRECTORY_KIB: "1024",
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
for entry in "$AGENT_TEST_SOURCE"/skills/*; do
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
        agentCopyHelperHarness(`
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" skills Codex
printf "continued"
`),
        {
          PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
          AGENT_COPY_MAX_DIRECTORY_ENTRIES: "3",
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
        agentCopyHelperHarness(`
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" skills Codex
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
          // Generous entry cap so only the size cap can reject this directory.
          AGENT_COPY_MAX_DIRECTORY_ENTRIES: "1000",
          AGENT_COPY_MAX_DIRECTORY_KIB: "8",
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
        agentCopyHelperHarness(`
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" skills Codex
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
          // Exactly the real entry count. A line-based count sees four.
          AGENT_COPY_MAX_DIRECTORY_ENTRIES: "2",
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
        agentCopyHelperHarness(`
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" config.toml Codex
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" skills Codex
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
          AGENT_COPY_MAX_FILE_BYTES: "not-a-number",
          AGENT_COPY_MAX_DIRECTORY_ENTRIES: "many",
          AGENT_COPY_MAX_DIRECTORY_KIB: "1e6",
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
        agentCopyHelperHarness(`
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" auth.json Codex
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
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
        agentCopyHelperHarness(`
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" auth.json Codex
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" skills Codex
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: destination,
        },
      );

      expect(conflictResult.exitCode).toBe(0);
      expect(conflictResult.stdout).toContain("destination is a directory");
      expect(conflictResult.stdout).toContain("destination is not a directory");
      expect(conflictResult.stdout).toEndWith("continued");

      const blockedDestination = join(dir, "blocked-destination");
      writeFileSync(blockedDestination, "not a directory\n");
      const mkdirResult = runShell(
        agentCopyHelperHarness(`
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" auth.json Codex
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" skills Codex
printf "continued"
`),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: blockedDestination,
        },
      );

      expect(mkdirResult.exitCode).toBe(0);
      expect(mkdirResult.stdout).toContain(
        "Failed to create destination for Codex file: auth.json",
      );
      expect(mkdirResult.stdout).toContain(
        "Failed to create destination for Codex directory: skills",
      );
      expect(mkdirResult.stdout).toEndWith("continued");

      const fakeBin = join(dir, "fake-bin");
      const copyFailureDestination = join(dir, "copy-failure-destination");
      mkdirSync(fakeBin);
      writeFileSync(join(fakeBin, "cp"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(fakeBin, "cp"), 0o755);
      const copyResult = runShell(
        agentCopyHelperHarness(`
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" auth.json Codex
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" skills Codex
printf "continued"
`),
        {
          PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: copyFailureDestination,
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
          agentCopyHelperHarness(`
copy_agent_file "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" auth.json Codex
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" skills Codex
printf "continued"
`),
          {
            PATH: pathWithFake(name, script),
            AGENT_TEST_SOURCE: source,
            AGENT_TEST_DESTINATION: destination,
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
        agentCopyHelperHarness(`
copy_agent_directory "$AGENT_TEST_SOURCE" "$AGENT_TEST_DESTINATION" skills Codex
printf "continued"
`),
        {
          PATH: `${duNonNumericBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          AGENT_TEST_SOURCE: source,
          AGENT_TEST_DESTINATION: nonNumericDestination,
        },
      );
      expect(nonNumeric.exitCode).toBe(0);
      expect(nonNumeric.stdout).toContain("Warning: Failed to inspect Codex directory: skills");
      expect(nonNumeric.stdout).toEndWith("continued");
      expect(() => statSync(join(nonNumericDestination, "skills"))).toThrow();
    });
  }, 15_000);

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
eval "$(sed -n '/^agent_copy_warn() {/,/^}$/p; /^report_agent_copy_skips() {/,/^}$/p; /^agent_source_path_has_symlink() {/,/^}$/p; /^agent_destination_path_has_symlink() {/,/^}$/p; /^copy_agent_file() {/,/^}$/p; /^copy_agent_directory() {/,/^}$/p' ${shellQuote(entrypoint)})"
codex_setup="$(sed -n '/^# Set up Codex configuration$/,/^log_progress "Codex configuration ready"$/p' ${shellQuote(entrypoint)} | sed "s#/codex-home#\\$AGENT_TEST_SOURCE#g")"
eval "$codex_setup"
`,
        {
          HOME: home,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      for (const file of files) {
        expect(readFileSync(join(destination, file), "utf8")).toBe(`${file}\n`);
      }
      for (const directory of directories) {
        expect(readFileSync(join(destination, directory, "copied.txt"), "utf8")).toBe(
          `${directory}\n`,
        );
      }
      expect(statSync(join(destination, "auth.json")).mode & 0o777).toBe(0o600);
      expect(() => statSync(join(destination, "plugins", ".plugin-appserver"))).toThrow();
      expect(() => statSync(join(destination, "sessions"))).toThrow();
    });
  });

  test("Cursor and Grok setup copy portable inputs while leaving runtime homes writable", () => {
    withTempDir((dir) => {
      const cursorSource = join(dir, "cursor-config");
      const grokSource = join(dir, "grok-home");
      const grokConfig = join(dir, "grok-config");
      const home = join(dir, "home");

      mkdirSync(join(cursorSource, "skills"), { recursive: true });
      mkdirSync(join(cursorSource, "skills-cursor"), { recursive: true });
      mkdirSync(join(cursorSource, "projects", "host-project"), { recursive: true });
      for (const file of ["cli-config.json", "agent-cli-state.json", "mcp.json", "argv.json"]) {
        writeFileSync(join(cursorSource, file), `${file}\n`);
      }
      writeFileSync(join(cursorSource, "skills", "personal.md"), "cursor personal skill\n");
      writeFileSync(join(cursorSource, "skills-cursor", "skill.md"), "cursor skill\n");
      writeFileSync(join(cursorSource, "projects", "host-project", "session.json"), "excluded\n");

      mkdirSync(join(grokSource, "hooks"), { recursive: true });
      mkdirSync(join(grokSource, "skills"), { recursive: true });
      mkdirSync(join(grokSource, "sessions"), { recursive: true });
      for (const file of ["auth.json", "config.toml", "trusted_folders.toml", "agent_id"]) {
        writeFileSync(join(grokSource, file), `${file}\n`, { mode: 0o644 });
      }
      writeFileSync(join(grokSource, "hooks", "hook.sh"), "hook\n");
      writeFileSync(join(grokSource, "skills", "skill.md"), "grok skill\n");
      writeFileSync(join(grokSource, "sessions", "host-session.json"), "excluded\n");
      mkdirSync(grokConfig, { recursive: true });
      writeFileSync(join(grokConfig, "settings.json"), '{"portable":true}\n');

      const entrypoint = join(repoRoot, "docker", "entrypoint.sh");
      const result = runShell(
        agentCopyHelperHarness(`
cursor_setup="$(sed -n '/^# Set up Cursor Agent configuration\./,/^log_progress "Cursor Agent configuration ready"$/p' ${shellQuote(entrypoint)} | sed "s#/cursor-config#\\$AGENT_TEST_CURSOR#g")"
grok_setup="$(sed -n '/^# Set up Grok configuration\./,/^log_progress "Grok configuration ready"$/p' ${shellQuote(entrypoint)} | sed "s#/grok-home#\\$AGENT_TEST_GROK_HOME#g; s#/grok-config#\\$AGENT_TEST_GROK_CONFIG#g")"
[ -n "$cursor_setup" ] || { echo "harness failed to extract the Cursor block"; exit 9; }
[ -n "$grok_setup" ] || { echo "harness failed to extract the Grok block"; exit 9; }
eval "$cursor_setup"
eval "$grok_setup"
`),
        {
          HOME: home,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_CURSOR: cursorSource,
          AGENT_TEST_GROK_HOME: grokSource,
          AGENT_TEST_GROK_CONFIG: grokConfig,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      for (const file of ["cli-config.json", "agent-cli-state.json", "mcp.json", "argv.json"]) {
        expect(readFileSync(join(home, ".cursor", file), "utf8")).toBe(`${file}\n`);
      }
      expect(readFileSync(join(home, ".cursor", "skills", "personal.md"), "utf8")).toBe(
        "cursor personal skill\n",
      );
      expect(readFileSync(join(home, ".cursor", "skills-cursor", "skill.md"), "utf8")).toBe(
        "cursor skill\n",
      );
      expect(() => statSync(join(home, ".cursor", "projects"))).toThrow();

      for (const file of ["auth.json", "config.toml", "trusted_folders.toml", "agent_id"]) {
        expect(readFileSync(join(home, ".grok", file), "utf8")).toBe(`${file}\n`);
      }
      expect(statSync(join(home, ".grok", "auth.json")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(home, ".grok", "hooks", "hook.sh"), "utf8")).toBe("hook\n");
      expect(readFileSync(join(home, ".grok", "skills", "skill.md"), "utf8")).toBe("grok skill\n");
      expect(readFileSync(join(home, ".config", "grok", "settings.json"), "utf8")).toBe(
        '{"portable":true}\n',
      );
      expect(() => statSync(join(home, ".grok", "sessions"))).toThrow();

      // These homes are ordinary directories created under HOME, not read-only
      // bind mount targets. Both agents can create the session state ACP needs.
      writeFileSync(join(home, ".cursor", "runtime-write"), "ok\n");
      writeFileSync(join(home, ".grok", "runtime-write"), "ok\n");
    });
  });

  test("Cursor and Grok name every entry they drop, including the whole-mount grok config", () => {
    withTempDir((dir) => {
      const cursorSource = join(dir, "cursor-config");
      const grokSource = join(dir, "grok-home");
      const grokConfig = join(dir, "grok-config");
      const outside = join(dir, "outside");
      const home = join(dir, "home");

      mkdirSync(join(outside, "real"), { recursive: true });
      writeFileSync(join(outside, "real", "leaked.md"), "host-only\n");

      // Cursor: one real skill beside a symlinked one. The per-entry helper must
      // drop only the link and still land the rest.
      mkdirSync(join(cursorSource, "skills-cursor"), { recursive: true });
      writeFileSync(join(cursorSource, "cli-config.json"), "cli-config.json\n");
      writeFileSync(join(cursorSource, "skills-cursor", "skill.md"), "cursor skill\n");
      symlinkSync(join(outside, "real"), join(cursorSource, "skills-cursor", "linked"));

      // Grok: an oversized file next to the allowlist, plus a link inside
      // ~/.config/grok, which is copied whole rather than per entry.
      mkdirSync(grokSource, { recursive: true });
      writeFileSync(join(grokSource, "auth.json"), "auth.json\n");
      writeFileSync(join(grokSource, "config.toml"), "x".repeat(64), { mode: 0o644 });
      mkdirSync(grokConfig, { recursive: true });
      writeFileSync(join(grokConfig, "settings.json"), '{"portable":true}\n');
      symlinkSync(join(outside, "real"), join(grokConfig, "linked"));

      const entrypoint = join(repoRoot, "docker", "entrypoint.sh");
      const result = runShell(
        agentCopyHelperHarness(`
cursor_setup="$(sed -n '/^# Set up Cursor Agent configuration\./,/^log_progress "Cursor Agent configuration ready"$/p' ${shellQuote(entrypoint)} | sed "s#/cursor-config#\\$AGENT_TEST_CURSOR#g")"
grok_setup="$(sed -n '/^# Set up Grok configuration\./,/^log_progress "Grok configuration ready"$/p' ${shellQuote(entrypoint)} | sed "s#/grok-home#\\$AGENT_TEST_GROK_HOME#g; s#/grok-config#\\$AGENT_TEST_GROK_CONFIG#g")"
eval "$cursor_setup"
eval "$grok_setup"
`),
        {
          HOME: home,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          // Small enough that the 64-byte config.toml above trips the file cap,
          // while every other fixture file stays comfortably under it.
          AGENT_COPY_MAX_FILE_BYTES: "32",
          AGENT_TEST_CURSOR: cursorSource,
          AGENT_TEST_GROK_HOME: grokSource,
          AGENT_TEST_GROK_CONFIG: grokConfig,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      // Each skip is attributed to the agent whose state was dropped, and the
      // summaries do not leak across the two blocks.
      expect(result.stdout).toContain(
        "Cursor host config NOT copied into this container: skills-cursor/linked",
      );
      expect(result.stdout).toContain("Skipping oversized Grok file: config.toml");
      // The mount is copied whole, so the entry the helper walks is ".". A
      // summary reading "NOT copied into this container: ." would name nothing
      // the user could act on.
      expect(result.stdout).toContain(
        "Grok host config NOT copied into this container: config.toml, .config/grok",
      );
      expect(result.stdout).not.toContain("container: .\n");

      // Dropping one entry does not cost the others, and no link was followed.
      expect(readFileSync(join(home, ".cursor", "cli-config.json"), "utf8")).toBe(
        "cli-config.json\n",
      );
      expect(readFileSync(join(home, ".cursor", "skills-cursor", "skill.md"), "utf8")).toBe(
        "cursor skill\n",
      );
      expect(() => statSync(join(home, ".cursor", "skills-cursor", "linked"))).toThrow();
      expect(readFileSync(join(home, ".grok", "auth.json"), "utf8")).toBe("auth.json\n");
      expect(() => statSync(join(home, ".grok", "config.toml"))).toThrow();
      // The whole-directory helper is all-or-nothing, so the link takes the
      // portable sibling with it rather than resolving out of the mount.
      expect(() => statSync(join(home, ".config", "grok", "settings.json"))).toThrow();
      expect(() => statSync(join(home, ".config", "grok", "linked"))).toThrow();
    });
  });

  test("Claude setup block copies the allowlist, skips history, and drops only the symlinked command", () => {
    withTempDir((dir) => {
      const source = join(dir, "claude-config");
      const home = join(dir, "home");
      const outside = join(dir, "outside");
      mkdirSync(join(source, "commands"), { recursive: true });
      mkdirSync(join(source, "projects"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(source, "CLAUDE.md"), "global instructions\n");
      writeFileSync(join(source, "settings.local.json"), '{"local":true}\n');
      writeFileSync(join(source, "history.jsonl"), '{"display":"secret prompt"}\n');
      writeFileSync(join(source, "daemon.log"), "log\n");
      writeFileSync(
        join(source, ".credentials.json"),
        '{"claudeAiOauth":{"accessToken":"from-mount"}}',
      );
      writeFileSync(join(source, "commands", "kept.md"), "kept\n");
      writeFileSync(join(outside, "secret.md"), "host content outside the tree\n");
      symlinkSync(join(outside, "secret.md"), join(source, "commands", "linked.md"));
      writeFileSync(join(source, "projects", "host.jsonl"), "host state\n");

      const entrypoint = join(repoRoot, "docker", "entrypoint.sh");
      const result = runShell(
        agentCopyHelperHarness(`
claude_setup="$(sed -n '/^log_progress "Setting up Claude Code configuration..."$/,/^log_progress "Claude Code configuration ready"$/p' ${shellQuote(entrypoint)} | sed "s#/claude-config#\\$AGENT_TEST_SOURCE#g")"
[ -n "$claude_setup" ] || { echo "harness failed to extract the Claude block"; exit 9; }
eval "$claude_setup"
`),
        {
          HOME: home,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_SOURCE: source,
        },
      );

      expect(result.exitCode).toBe(0);
      // The allowlisted config lands in the container home.
      expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toBe(
        "global instructions\n",
      );
      expect(readFileSync(join(home, ".claude", "settings.local.json"), "utf8")).toBe(
        '{"local":true}\n',
      );
      // settings.json is rewritten by the block with the container's own settings.
      expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toContain(
        "bypassPermissions",
      );
      // No backend sync has run, so the mounted credential is the fallback source.
      expect(readFileSync(join(home, ".claude", ".credentials.json"), "utf8")).toContain(
        "from-mount",
      );
      expect(statSync(join(home, ".claude", ".credentials.json")).mode & 0o777).toBe(0o600);
      // The real command survives; only the symlinked one is skipped.
      expect(readFileSync(join(home, ".claude", "commands", "kept.md"), "utf8")).toBe("kept\n");
      expect(() => statSync(join(home, ".claude", "commands", "linked.md"))).toThrow();
      expect(() => statSync(join(home, ".claude", "commands", "secret.md"))).toThrow();
      // Host history and per-project transcripts never enter the container. The
      // entrypoint itself creates an empty `projects` scratch dir for Claude, so
      // it is the host's per-project content that must be absent, not the dir.
      for (const excluded of ["history.jsonl", "daemon.log"]) {
        expect(() => statSync(join(home, ".claude", excluded))).toThrow();
      }
      expect(() => statSync(join(home, ".claude", "projects", "host.jsonl"))).toThrow();
      // The per-entry skip is surfaced in the consolidated summary.
      expect(result.stdout).toContain("commands/linked.md");
    });
  });

  test("OpenCode setup block merges user config, skips the database, and copies data per-entry", () => {
    withTempDir((dir) => {
      const config = join(dir, "opencode-config");
      const data = join(dir, "opencode-data");
      const state = join(dir, "opencode-state");
      const model = join(dir, "opencode-model");
      const home = join(dir, "home");
      const outside = join(dir, "outside");
      mkdirSync(join(config, "plugin"), { recursive: true });
      mkdirSync(join(config, "node_modules", "some-dep"), { recursive: true });
      mkdirSync(join(data, "storage"), { recursive: true });
      mkdirSync(join(data, "snapshot"), { recursive: true });
      mkdirSync(join(data, "log"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(config, "opencode.json"), '{"config":true}\n');
      writeFileSync(join(config, "plugin", "custom.ts"), "export default {}\n");
      writeFileSync(join(config, "node_modules", "some-dep", "binary.node"), "mach-o\n");
      writeFileSync(join(data, "auth.json"), '{"token":"opencode"}\n', { mode: 0o600 });
      writeFileSync(join(data, "account.json"), '{"account":"test"}\n');
      writeFileSync(join(data, "opencode.db"), "x".repeat(1024 * 1024));
      writeFileSync(join(data, "storage", "kept.json"), "kept\n");
      writeFileSync(join(data, "snapshot", "kept.json"), "kept\n");
      writeFileSync(join(outside, "leaked.json"), "outside\n");
      symlinkSync(join(outside, "leaked.json"), join(data, "storage", "linked.json"));
      writeFileSync(join(data, "log", "huge.log"), "runtime log\n");

      const entrypoint = join(repoRoot, "docker", "entrypoint.sh");
      const result = runShell(
        agentCopyHelperHarness(`
opencode_setup="$(sed -n '/^log_progress "Setting up OpenCode configuration..."$/,/^log_progress "OpenCode configuration ready"$/p' ${shellQuote(entrypoint)} | sed "s#/opencode-config#\\$AGENT_TEST_CONFIG#g; s#/opencode-data#\\$AGENT_TEST_DATA#g; s#/opencode-state#\\$AGENT_TEST_STATE#g; s#/opencode-model.json#\\$AGENT_TEST_MODEL.json#g")"
[ -n "$opencode_setup" ] || { echo "harness failed to extract the OpenCode block"; exit 9; }
eval "$opencode_setup"
`),
        {
          HOME: home,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_TEST_CONFIG: config,
          AGENT_TEST_DATA: data,
          AGENT_TEST_STATE: state,
          AGENT_TEST_MODEL: model,
        },
      );

      expect(result.exitCode).toBe(0);
      // User-authored config merges; Mach-O node_modules is the one exclusion.
      expect(readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8")).toBe(
        '{"config":true}\n',
      );
      expect(readFileSync(join(home, ".config", "opencode", "plugin", "custom.ts"), "utf8")).toBe(
        "export default {}\n",
      );
      expect(() => statSync(join(home, ".config", "opencode", "node_modules"))).toThrow();
      // Credential rides the mount; the multi-GB session database does not.
      expect(readFileSync(join(home, ".local", "share", "opencode", "auth.json"), "utf8")).toBe(
        '{"token":"opencode"}\n',
      );
      expect(readFileSync(join(home, ".local", "share", "opencode", "account.json"), "utf8")).toBe(
        '{"account":"test"}\n',
      );
      expect(() => statSync(join(home, ".local", "share", "opencode", "opencode.db"))).toThrow();
      // Data directories copy per-entry: real records land, the symlinked one
      // is skipped individually, and the excluded runtime dir never appears.
      expect(
        readFileSync(join(home, ".local", "share", "opencode", "storage", "kept.json"), "utf8"),
      ).toBe("kept\n");
      expect(
        readFileSync(join(home, ".local", "share", "opencode", "snapshot", "kept.json"), "utf8"),
      ).toBe("kept\n");
      expect(() =>
        statSync(join(home, ".local", "share", "opencode", "storage", "linked.json")),
      ).toThrow();
      expect(() => statSync(join(home, ".local", "share", "opencode", "log"))).toThrow();
    });
  });

  test("workspace setup exits early when a prior setup already completed", () => {
    const setup = read("docker/workspace-setup.sh");
    const completionGuard = setup.indexOf("if [ -f /tmp/.workspace-setup-complete ]; then");
    const cloneBlock = setup.indexOf('if [ -n "$GIT_URL" ] && [ ! -d "/workspace/.git" ]; then');

    expect(completionGuard).toBeGreaterThan(0);
    expect(cloneBlock).toBeGreaterThan(completionGuard);
    expect(setup).toContain("Workspace already set up.");
    expect(setup).toContain("exit 0");
  });

  test("container native launch paths source the captured runtime environment", () => {
    const backend = [
      read("apps/backend/src/core/commands-registry-servers.ts"),
      read("apps/backend/src/core/commands-servers.ts"),
      read("apps/backend/src/core/commands-runtime-state.ts"),
      read("apps/backend/src/core/commands-containers.ts"),
    ].join("\n");

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
      const marker = `function ${name}(`;
      const start = backend.indexOf(marker);
      expect(start).toBeGreaterThan(0);
      // Helpers are top-level, so the next top-level declaration ends the body.
      const nextDeclaration = backend
        .slice(start + 1)
        .search(/\n(?:export )?(?:async )?function \w+\(|\n(?:export )?const \w+ = /);
      return nextDeclaration === -1
        ? backend.slice(start)
        : backend.slice(start, start + 1 + nextDeclaration);
    }

    const commands = ["start_opencode_server", "start_claude_server", "start_codex_server"];

    for (const command of commands) {
      const start = backend.indexOf(`register("${command}"`);
      expect(start).toBeGreaterThan(0);
      // Bound the block at the next register(...) call, regardless of its
      // indentation, so these assertions can only be satisfied by THIS
      // command's block and never leak into a neighbouring one.
      const nextRegister = backend.slice(start + 1).search(/\n\s*register\(/);
      const registerBlock =
        nextRegister === -1 ? backend.slice(start) : backend.slice(start, start + 1 + nextRegister);
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
      expect(result.stdout).toBe(`FOUND\nbun=${overrideBunInstall}\n${overrideBun}\nOVERRIDE_BUN`);
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
