import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

  test("container native launch paths source the captured runtime environment", () => {
    const files = [
      "src-tauri/src/commands/claude.rs",
      "src-tauri/src/commands/codex.rs",
      "src-tauri/src/commands/opencode.rs",
      "src-tauri/src/pty/mod.rs",
    ];

    for (const file of files) {
      expect(read(file)).toContain("orkestrator_source_runtime_env");
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
      expect(captured).toContain("export PATH=");
      expect(captured).toContain("export CARGO_HOME=");
      expect(captured).toContain("export BUN_INSTALL=");
      expect(captured).not.toContain("SECRET_TOKEN");
      expect(captured).not.toContain("do-not-capture");
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
