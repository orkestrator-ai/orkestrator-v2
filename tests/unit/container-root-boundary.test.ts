import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTAINER_INTERACTIVE_SHELL_COMMAND,
  CONTAINER_ROOT_PATH,
  CONTAINER_ROOT_USER_ARGS,
  CONTAINER_TERMINAL_CLOSE_SCRIPT,
  containerTerminalUserArgs,
  isContainerRootUser,
} from "../../apps/backend/src/core/container-scripts";

/**
 * Security report finding H2: the container's node user must not get code run
 * as root. Root execs get a fixed PATH, root scripts reset PATH themselves,
 * root shells source nothing node owns, and the image keeps the directories
 * involved root-owned (docker/verify-root-boundary.sh checks the built image,
 * docker/tests/root-boundary-smoke.sh plants files in it).
 */
const repoRoot = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function backendSources(dir = join(repoRoot, "apps/backend/src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return backendSources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("root execs", () => {
  test("run with a PATH of root-owned system directories only", () => {
    expect(CONTAINER_ROOT_PATH).toBe("/usr/sbin:/usr/bin:/sbin:/bin");
    expect(CONTAINER_ROOT_USER_ARGS).toEqual([
      "--env",
      "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
      "--user",
      "root",
    ]);
  });

  test("no backend docker call names the root user without the fixed PATH", () => {
    const offenders = backendSources()
      // The helper itself defines CONTAINER_ROOT_USER_ARGS.
      .filter((file) => !file.endsWith("/container-scripts.ts"))
      .filter((file) => /"(?:--user|-u)",\s*"(?:root|orkroot|0)"/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("root terminals get the fixed PATH and node terminals keep theirs", () => {
    for (const user of ["root", "orkroot", "0", "0:0", "root:root"]) {
      expect(isContainerRootUser(user)).toBe(true);
      expect(containerTerminalUserArgs(user)).toEqual([
        "--env",
        `PATH=${CONTAINER_ROOT_PATH}`,
        "--user",
        user,
      ]);
    }
    for (const user of ["node", "1000", "1000:1000", "rooter"]) {
      expect(isContainerRootUser(user)).toBe(false);
      expect(containerTerminalUserArgs(user)).toEqual(["--user", user]);
    }
    expect(containerTerminalUserArgs(undefined)).toEqual([]);
  });

  test("terminal launches and closes pass their user through the root-aware helper", () => {
    const terminal = read("apps/backend/src/core/commands-registry-terminal.ts");
    expect(terminal).not.toContain('dockerArgs.push("--user", config.user)');
    // Every container terminal starts through spawnContainerTerminal.
    expect(terminal.match(/containerTerminalUserArgs\(config\.user\)/g)).toHaveLength(1);
    const close = read("apps/backend/src/core/container-terminal-shell.ts");
    expect(close.match(/containerTerminalUserArgs\(shell\.user\)/g)).toHaveLength(1);
  });
});

describe("root scripts", () => {
  const ROOT_RESET = "PATH=/usr/sbin:/usr/bin:/sbin:/bin";
  const scripts: Record<string, string> = {
    "docker/orkestrator-drain.sh": ROOT_RESET,
    "docker/update-firewall.sh": ROOT_RESET,
    "docker/init-firewall.sh": ROOT_RESET,
    "docker/orkestrator-storage.sh": ROOT_RESET,
    "docker/orkestrator-migrate.sh": ROOT_RESET,
    "docker/orkestrator-egress-gateway.sh": ROOT_RESET,
    "docker/verify-root-boundary.sh": ROOT_RESET,
    // sudo's secure_path, which node's entrypoint.sh also inherits.
    "docker/network-policy-entrypoint.sh":
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };

  for (const [script, reset] of Object.entries(scripts)) {
    test(`${script} resets PATH before running any command`, () => {
      const commands = read(script)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && !line.startsWith("set -"));
      expect(commands[0]).toBe(reset);
      expect(commands[1]).toBe("export PATH");
    });
  }
});

describe("root shells", () => {
  const helper = join(repoRoot, "docker/runtime-env.sh");

  function rootShell(dir: string, script: string) {
    const result = Bun.spawnSync({
      // Sourced as a terminal does, then answering uid 0 the way the image's
      // orkroot does; the host test user cannot be root.
      cmd: ["bash", "-c", `. ${quote(helper)}\norkestrator_is_root() { return 0; }\n${script}`],
      env: {
        HOME: join(dir, "home"),
        PATH: `/usr/local/share/npm-global/bin:${join(dir, "bin")}:/usr/bin:/bin`,
        BASH_ENV: join(dir, "bash-env.sh"),
        NPM_CONFIG_PREFIX: "/usr/local/share/npm-global",
        MISE_TRUSTED_CONFIG_PATHS: "/workspace",
        ORKESTRATOR_RUNTIME_ENV_FILE: join(dir, "runtime-env.sh"),
        ORKESTRATOR_BASH_ENV_FILE: join(dir, "bash-env.sh"),
        ORKESTRATOR_GITHUB_CREDENTIAL_FILE: join(dir, "github-token"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: result.exitCode, stdout: result.stdout.toString() };
  }

  test("never source node's runtime snapshot and take only root-owned directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "ork-root-shell-"));
    try {
      const marker = join(dir, "sourced");
      writeFileSync(
        join(dir, "runtime-env.sh"),
        `# orkestrator-runtime-env: v3\necho runtime-env > ${quote(marker)}\nPATH="/planted:$PATH"\n`,
      );
      writeFileSync(join(dir, "github-token"), "gh-token", { mode: 0o600 });
      const result = rootShell(
        dir,
        `orkestrator_source_runtime_env
printf '%s|%s|%s|%s|%s' "$PATH" "\${BASH_ENV-unset}" "\${NPM_CONFIG_PREFIX-unset}" "\${MISE_TRUSTED_CONFIG_PATHS-unset}" "\${GH_TOKEN:-}"`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin|unset|unset|unset|gh-token",
      );
      expect(existsSync(marker)).toBe(false);
      // Nothing written into node's directory either.
      expect(existsSync(join(dir, "bash-env.sh"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never capture a snapshot or write bash-env.sh into node's directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ork-root-shell-"));
    try {
      const result = rootShell(
        dir,
        `orkestrator_capture_runtime_env
orkestrator_ensure_bash_env
printf '%s' "\${BASH_ENV-unset}"`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("unset");
      expect(existsSync(join(dir, "runtime-env.sh"))).toBe(false);
      expect(existsSync(join(dir, "bash-env.sh"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detect root with an absolute id, before PATH is trusted", () => {
    expect(read("docker/runtime-env.sh")).toContain('[ "$(/usr/bin/id -u 2>/dev/null)" = 0 ]');
  });

  test("root zsh skips completion directories it does not own", () => {
    const zshrc = read("docker/container-zshrc.zsh");
    expect(zshrc).toMatch(/if \(\( EUID == 0 \)\); then\n\s+compinit -i\nelse\n\s+compinit -u\nfi/);
  });
});

describe("image", () => {
  const dockerfile = read("docker/Dockerfile");

  test("keeps /usr/local/share root-owned with node's npm-global inside it", () => {
    expect(dockerfile).not.toMatch(/chown -R node:node \/usr\/local\/share(?:\s|$)/);
    expect(dockerfile).toContain(
      "RUN install -d -o node -g node -m 0755 /usr/local/share/npm-global",
    );
    expect(dockerfile).toContain("ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global");
  });

  test("verifies the root boundary after every file is installed", () => {
    const verify = dockerfile.indexOf("&& /usr/local/share/verify-root-boundary.sh");
    expect(verify).toBeGreaterThan(-1);
    for (const lastCopy of [
      "COPY docker/runtime-env.sh /usr/local/bin/orkestrator-runtime-env.sh",
      "COPY docker/orkestrator-drain.sh /usr/local/bin/orkestrator-drain.sh",
      "COPY docker/container-zshrc.zsh /etc/orkestrator/zshrc",
    ]) {
      expect(dockerfile.indexOf(lastCopy)).toBeGreaterThan(-1);
      expect(dockerfile.indexOf(lastCopy)).toBeLessThan(verify);
    }
  });

  test("the final image smoke plants files as node and checks root ran none", () => {
    expect(read("docker/tests/final-image-smoke.sh")).toContain("root-boundary-smoke.sh");
    const smoke = read("docker/tests/root-boundary-smoke.sh");
    expect(smoke).toContain(`ROOT_PATH=${CONTAINER_ROOT_PATH}`);
    // The smoke runs the backend's exact root terminal launch and close.
    expect(smoke.match(/^TERMINAL_COMMAND='([^']*)'$/m)?.[1]).toBe(
      CONTAINER_INTERACTIVE_SHELL_COMMAND,
    );
    expect(smoke.match(/^CLOSE_SCRIPT='([^']*)'$/m)?.[1]).toBe(CONTAINER_TERMINAL_CLOSE_SCRIPT);
  });
});
