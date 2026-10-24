import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeStateSignalConfig } from "./claude-state-signal.js";
import {
  WORKTREE_SIGNAL_INSTALL_TIMEOUT_MS,
  WORKTREE_SIGNAL_SCRIPT_PATH,
  worktreeSignalInstallCommand,
} from "./container-worktree-signal-install.js";

const SCRIPT = join(import.meta.dir, "../../../../docker/orkestrator-worktree-signal.sh");
const credential = {
  url: "http://host.docker.internal:43123/worktree-signal",
  token: "B".repeat(43),
};

describe("worktree signal install", () => {
  test("hands the curl config over stdin, so the token never reaches argv", () => {
    const { command, args, options } = worktreeSignalInstallCommand("container-1", credential);
    expect(command).toBe("docker");
    expect(args).toEqual([
      "exec",
      "-i",
      "--user",
      "node",
      "container-1",
      WORKTREE_SIGNAL_SCRIPT_PATH,
      "start",
    ]);
    expect(options).toEqual({
      stdin: claudeStateSignalConfig(credential),
      timeoutMs: WORKTREE_SIGNAL_INSTALL_TIMEOUT_MS,
      redactValues: [credential.token],
    });
  });
});

/** The script needs bash 5 (`EPOCHREALTIME`, fractional `read -t`), as in the image. */
function bash5(): string | null {
  const bash = Bun.which("bash");
  if (!bash) return null;
  const version = spawnSync(bash, ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" });
  return Number(version.stdout.trim()) >= 5 ? bash : null;
}
const bash = bash5();
const scriptTest = bash ? test : test.skip;

describe("orkestrator-worktree-signal", () => {
  /** Fake `inotifywait`, `curl` and `setsid` in a private PATH; every ring is logged. */
  function withFakes(
    events: string,
    body: (dir: string, run: (mode: string, stdin?: string) => number) => void,
  ): void {
    const dir = mkdtempSync(join(tmpdir(), "ork-worktree-signal-"));
    try {
      const write = (name: string, text: string) => {
        writeFileSync(join(dir, name), text);
        chmodSync(join(dir, name), 0o755);
      };
      write("inotifywait", `#!/bin/sh\n${events}\n`);
      write(
        "curl",
        `#!/bin/sh\nfor arg in "$@"; do case "$arg" in X-Orkestrator-Signal:*) echo "\${arg#*: }" >> ${JSON.stringify(join(dir, "rings"))} ;; esac; done\n`,
      );
      // macOS has no setsid; the real one detaches, this one runs in the
      // foreground, under the bash being tested rather than the shebang's.
      write("setsid", `#!/bin/sh\n[ "$1" = -f ] && shift\nexec ${JSON.stringify(bash)} "$@"\n`);
      for (const tool of ["tr", "grep", "mv", "rm", "cat", "sleep", "kill"]) {
        const found = Bun.which(tool);
        if (found) write(tool, `#!/bin/sh\nexec ${JSON.stringify(found)} "$@"\n`);
      }
      const run = (mode: string, stdin = "") =>
        spawnSync(bash!, [SCRIPT, mode], {
          input: stdin,
          env: {
            PATH: dir,
            ORKESTRATOR_WORKTREE_SIGNAL_ROOT: dir,
            ORKESTRATOR_WORKTREE_SIGNAL_CONFIG: join(dir, "config"),
          },
          encoding: "utf8",
          timeout: 10_000,
        }).status ?? -1;
      body(dir, run);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Rings are detached requests, so they are compared without their order. */
  const rings = (dir: string) => {
    try {
      return readFileSync(join(dir, "rings"), "utf8").trim().split("\n").sort();
    } catch {
      return [];
    }
  };

  scriptTest("rings ready, one ring per burst, overflow, and lost when the watcher ends", () => {
    withFakes(
      [
        "echo 'Setting up watches.  Beware: since -r was given, this may take a while!' >&2",
        "echo 'Watches established.' >&2",
        "echo 'E CREATE'",
        "echo 'E CLOSE_WRITE,CLOSE'",
        "echo 'E CLOSE_WRITE,CLOSE'",
        "sleep 0.6",
        "echo 'E Q_OVERFLOW'",
        "sleep 0.6",
        "exit 1",
      ].join("\n"),
      (dir, run) => {
        writeFileSync(join(dir, "config"), 'url = "http://127.0.0.1:9/worktree-signal"\n');
        expect(run("watch")).toBe(0);
        // Three events in one burst are one ring.
        expect(rings(dir)).toEqual(["change", "lost", "overflow", "ready"]);
      },
    );
  });

  scriptTest("start writes a private config from stdin and launches the watcher", () => {
    withFakes("echo 'Watches established.' >&2; exit 1", (dir, run) => {
      expect(run("start", claudeStateSignalConfig(credential))).toBe(0);
      expect(readFileSync(join(dir, "config"), "utf8")).toBe(claudeStateSignalConfig(credential));
      expect(statSync(join(dir, "config")).mode & 0o777).toBe(0o600);
      // The fake setsid ran the watcher in the foreground: it rang and ended.
      expect(rings(dir)).toEqual(["lost", "ready"]);
      expect(run("bogus")).toBe(2);
    });
  });

  scriptTest("without a readable config nothing rings", () => {
    withFakes("echo 'Watches established.' >&2; echo 'E CREATE'; exit 1", (dir, run) => {
      expect(run("watch")).toBe(0);
      expect(rings(dir)).toEqual([]);
    });
  });
});
