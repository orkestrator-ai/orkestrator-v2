import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
  const result = Bun.spawnSync({
    cmd: ["sh", "-c", script],
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
      const block =
        nextRegister === -1
          ? backend.slice(start)
          : backend.slice(start, start + 1 + nextRegister);
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
