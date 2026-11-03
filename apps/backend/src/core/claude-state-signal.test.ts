import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_STATE_SIGNAL_CONFIG_PATH,
  CLAUDE_STATE_SIGNAL_INSTALL_TIMEOUT_MS,
  CLAUDE_STATE_SIGNAL_SCRIPT_PATH,
  claudeStateSignalConfig,
  claudeStateSignalInstallCommand,
  tmuxHookSignalInstallCommand,
} from "./claude-state-signal.js";
import { TMUX_HOOK_SIGNAL_CONFIG_PATH } from "./tmux-hook-signal.js";

const SCRIPT = join(import.meta.dir, "../../../../docker/orkestrator-state-signal.sh");
const credential = {
  url: "http://host.docker.internal:43123/claude-state-signal",
  token: "A".repeat(43),
};

describe("Claude state signal install", () => {
  test("writes the curl config from stdin, so the token never reaches argv", () => {
    const { command, args, options } = claudeStateSignalInstallCommand("container-1", credential);
    expect(command).toBe("docker");
    expect(args.slice(0, 5)).toEqual(["exec", "-i", "container-1", "sh", "-c"]);
    expect(args.join(" ")).not.toContain(credential.token);
    expect(args[5]).toContain(`mv -f "$tmp" "${CLAUDE_STATE_SIGNAL_CONFIG_PATH}"`);
    expect(args[5]).toContain("umask 077");
    // The install ends by ringing once: the probe that confirms the path.
    expect(args[5]?.trim().endsWith(`exec ${CLAUDE_STATE_SIGNAL_SCRIPT_PATH}`)).toBe(true);
    expect(options).toEqual({
      stdin: claudeStateSignalConfig(credential),
      timeoutMs: CLAUDE_STATE_SIGNAL_INSTALL_TIMEOUT_MS,
      redactValues: [credential.token],
    });
    expect(claudeStateSignalConfig(credential)).toBe(
      `url = "${credential.url}"\nheader = "Authorization: Bearer ${credential.token}"\n`,
    );
  });
});

describe("tmux hook signal install", () => {
  test("writes its own config and probes with the hook ring", () => {
    const { args, options } = tmuxHookSignalInstallCommand("container-1", credential);
    expect(args.slice(0, 5)).toEqual(["exec", "-i", "container-1", "sh", "-c"]);
    expect(args.join(" ")).not.toContain(credential.token);
    expect(args[5]).toContain(`mv -f "$tmp" "${TMUX_HOOK_SIGNAL_CONFIG_PATH}"`);
    expect(args[5]).not.toContain(CLAUDE_STATE_SIGNAL_CONFIG_PATH);
    expect(args[5]?.trim().endsWith(`exec ${CLAUDE_STATE_SIGNAL_SCRIPT_PATH} hook`)).toBe(true);
    expect(options.redactValues).toEqual([credential.token]);
  });
});

describe("orkestrator-state-signal", () => {
  /**
   * Runs the script sourced, then `wait`s, so the detached request has
   * finished before the assertions without any timer.
   */
  function run(dir: string, env: Record<string, string>) {
    return spawnSync("/bin/sh", ["-c", '. "$0"; wait', SCRIPT], {
      env: { PATH: dir, ORKESTRATOR_STATE_SIGNAL_CONFIG: join(dir, "config"), ...env },
      encoding: "utf8",
    });
  }

  function withFakeCurl(exitCode: number, body: (dir: string, argsFile: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "ork-state-signal-"));
    try {
      const argsFile = join(dir, "curl-args");
      writeFileSync(
        join(dir, "curl"),
        `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done > ${JSON.stringify(argsFile)}\nexit ${exitCode}\n`,
      );
      chmodSync(join(dir, "curl"), 0o755);
      body(dir, argsFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("posts with the provisioned config and succeeds even when the request fails", () => {
    withFakeCurl(7, (dir, argsFile) => {
      writeFileSync(join(dir, "config"), claudeStateSignalConfig(credential));
      const result = run(dir, {});
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      const args = readFileSync(argsFile, "utf8").trim().split("\n");
      expect(args.slice(0, 4)).toEqual(["--config", join(dir, "config"), "--request", "POST"]);
      expect(args).toContain("--fail");
      expect(args).toContain("--max-time");
      expect(args.join(" ")).not.toContain(credential.token);
    });
  });

  test("does nothing without a provisioned config or without curl", () => {
    withFakeCurl(0, (dir, argsFile) => {
      expect(run(dir, {}).status).toBe(0);
      expect(existsSync(argsFile)).toBe(false);
    });
    const empty = mkdtempSync(join(tmpdir(), "ork-state-signal-"));
    try {
      writeFileSync(join(empty, "config"), claudeStateSignalConfig(credential));
      expect(run(empty, {}).status).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("the hook ring posts with the tmux hook config and writes no state", () => {
    withFakeCurl(0, (dir, argsFile) => {
      writeFileSync(join(dir, "hook-config"), claudeStateSignalConfig(credential));
      writeFileSync(join(dir, "config"), claudeStateSignalConfig(credential));
      const result = spawnSync("/bin/sh", ["-c", 'set -- hook; . "$0"; wait', SCRIPT], {
        env: {
          PATH: dir,
          ORKESTRATOR_STATE_SIGNAL_CONFIG: join(dir, "config"),
          ORKESTRATOR_TMUX_HOOK_SIGNAL_CONFIG: join(dir, "hook-config"),
          ORKESTRATOR_STATE_FILE: join(dir, "state"),
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const args = readFileSync(argsFile, "utf8").trim().split("\n");
      expect(args.slice(0, 2)).toEqual(["--config", join(dir, "hook-config")]);
      expect(existsSync(join(dir, "state"))).toBe(false);
      expect(existsSync(join(dir, "state-snapshot"))).toBe(false);
    });
  });

  test("declares the capabilities its contract names", () => {
    const text = readFileSync(SCRIPT, "utf8");
    expect(text).toContain("ORKESTRATOR_CAPABILITY claude-state-signal=3");
    expect(text).toContain("ORKESTRATOR_CAPABILITY tmux-hook-signal=1");
  });
});
