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
  createContainerWorktreeSignalInstaller,
} from "./container-worktree-signal-install.js";
import type { WorktreeSignalReason } from "./agent-tools.js";
import {
  ContainerWorktreeSignals,
  CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS,
} from "./container-worktree-signal.js";
import { CommandFailedError, runCommand } from "./shell.js";
import { ManualTime, deferred, flushMicrotasks } from "./recurring-test-support.js";

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

  for (const stage of ["host", "ports", "exec"] as const) {
    for (const outcome of ["closed", "failed"] as const) {
      test(`${outcome} during ${stage} preparation stops installation and preserves lineage health`, async () => {
        const entered: string[] = [];
        const gate = deferred();
        let installSignal: AbortSignal | undefined;
        let revoked = false;
        const step = async (name: string, signal?: AbortSignal) => {
          entered.push(name);
          if (name !== stage) return;
          installSignal = signal;
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new Error("installation aborted"));
            signal?.addEventListener("abort", abort, { once: true });
            gate.promise.then(() => {
              signal?.removeEventListener("abort", abort);
              if (outcome === "failed") reject(new Error(`${stage} failed`));
              else resolve();
            });
          });
        };
        const installer = createContainerWorktreeSignalInstaller({
          ensureHost: (_id, signal) => step("host", signal),
          ensurePorts: (_id, _port, signal) => step("ports", signal),
          exec: async (_command, _args, options) => {
            await step("exec", options?.signal);
            return { stdout: "", stderr: "" };
          },
        });
        const signals = new ContainerWorktreeSignals({
          installer: { ...installer, support: async () => "supported" },
          context: () =>
            ({
              storage: {},
              agentTools: {
                issueWorktreeSignal: () => ({
                  ...credential,
                  revoke: () => {
                    revoked = true;
                  },
                }),
              },
            }) as never,
          onWarning: () => undefined,
        });
        const watcher = signals.start({ containerId: "container-1", onChange: () => undefined });
        await flushMicrotasks();
        expect(entered.at(-1)).toBe(stage);
        if (outcome === "closed") watcher.close();
        gate.resolve();
        await flushMicrotasks();
        expect(installSignal?.aborted).toBe(outcome === "closed");
        expect(entered).toEqual(
          ["host", "ports", "exec"].slice(0, ["host", "ports", "exec"].indexOf(stage) + 1),
        );
        expect(revoked).toBe(true);
        expect(signals.status().demotions).toEqual(outcome === "failed" ? { "arm-failed": 1 } : {});
        if (outcome === "failed") expect(signals.status().states.demoted).toBe(1);
        watcher.close();
      });
    }
  }
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
  async function withFakes(
    events: string,
    body: (dir: string, run: (mode: string, stdin?: string) => Promise<number>) => Promise<void>,
    timeoutMs = 20_000,
  ): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "ork-worktree-signal-"));
    try {
      const write = (name: string, text: string) => {
        writeFileSync(join(dir, name), text);
        chmodSync(join(dir, name), 0o755);
      };
      write("inotifywait", `#!/bin/sh\n${events}\n`);
      write(
        "curl",
        `#!${bash}\nfor arg in "$@"; do case "$arg" in X-Orkestrator-Signal:*) echo "\${arg#*: }" >> ${JSON.stringify(join(dir, "rings"))}; echo "$EPOCHREALTIME \${arg#*: }" >> ${JSON.stringify(join(dir, "ring-times"))} ;; esac; done\n`,
      );
      // macOS has no setsid; the real one detaches, this one runs in the
      // foreground, under the bash being tested rather than the shebang's.
      write("setsid", `#!/bin/sh\n[ "$1" = -f ] && shift\nexec ${JSON.stringify(bash)} "$@"\n`);
      for (const tool of ["tr", "grep", "mv", "rm", "cat", "sleep", "kill"]) {
        const found = Bun.which(tool);
        if (found) write(tool, `#!/bin/sh\nexec ${JSON.stringify(found)} "$@"\n`);
      }
      const run = async (mode: string, stdin = "") => {
        try {
          // runCommand owns a process group, so a timeout cannot signal the
          // Bun worker or leave the fake watcher running after this fixture.
          await runCommand(bash!, [SCRIPT, mode], {
            stdin,
            env: {
              PATH: dir,
              ORKESTRATOR_WORKTREE_SIGNAL_ROOT: dir,
              ORKESTRATOR_WORKTREE_SIGNAL_CONFIG: join(dir, "config"),
            },
            timeoutMs,
          });
          return 0;
        } catch (error) {
          if (error instanceof CommandFailedError && error.exitCode !== null) return error.exitCode;
          throw error;
        }
      };
      await body(dir, run);
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

  scriptTest(
    "rings ready, one ring per burst, overflow, and lost when the watcher ends",
    async () => {
      await withFakes(
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
        async (dir, run) => {
          writeFileSync(join(dir, "config"), 'url = "http://127.0.0.1:9/worktree-signal"\n');
          expect(await run("watch")).toBe(0);
          // Three events in one burst are one ring.
          expect(rings(dir)).toEqual(["change", "lost", "overflow", "ready"]);
        },
      );
    },
    30_000,
  );

  scriptTest(
    "continuous writes ring before max wait and keep a trailing notification",
    async () => {
      await withFakes(
        [
          "echo 'Watches established.' >&2",
          "i=0; while [ $i -lt 35 ]; do echo 'E MODIFY'; sleep 0.05; i=$((i+1)); done",
          // Even without a quiet window, the stream has already produced a ring.
          'test -s "$ORKESTRATOR_WORKTREE_SIGNAL_ROOT/rings" && cat "$ORKESTRATOR_WORKTREE_SIGNAL_ROOT/rings" > "$ORKESTRATOR_WORKTREE_SIGNAL_ROOT/during-writes"',
          "echo 'E MODIFY'",
          "sleep 1.3",
        ].join("\n"),
        async (dir, run) => {
          writeFileSync(join(dir, "config"), 'url = "http://127.0.0.1:9/worktree-signal"\n');
          expect(await run("watch")).toBe(0);
          expect(readFileSync(join(dir, "during-writes"), "utf8")).toContain("change");
          const during = readFileSync(join(dir, "during-writes"), "utf8").trim().split("\n");
          expect(rings(dir).filter((reason) => reason === "change").length).toBeGreaterThan(
            during.filter((reason) => reason === "change").length,
          );
          expect(rings(dir)).toContain("lost");
        },
      );
    },
    30_000,
  );

  scriptTest(
    "400 ms bursts over a minute stay qualified through the receiver and retain the tail",
    async () => {
      let recorded: Array<{ at: number; reason: WorktreeSignalReason }> = [];
      await withFakes(
        [
          "echo 'Watches established.' >&2",
          "i=0; while [ $i -lt 155 ]; do echo 'E MODIFY'; sleep 0.4; i=$((i+1)); done",
          // Read the rings while still alive: an intentional exit sends lost.
          "sleep 1.3",
          'cat "$ORKESTRATOR_WORKTREE_SIGNAL_ROOT/ring-times" > "$ORKESTRATOR_WORKTREE_SIGNAL_ROOT/before-exit"',
        ].join("\n"),
        async (dir, run) => {
          writeFileSync(join(dir, "config"), 'url = "http://127.0.0.1:9/worktree-signal"\n');
          expect(await run("watch")).toBe(0);
          recorded = readFileSync(join(dir, "before-exit"), "utf8")
            .trim()
            .split("\n")
            .map((line) => {
              const [at, reason] = line.split(" ");
              return { at: Number(at) * 1_000, reason: reason as WorktreeSignalReason };
            })
            .sort((a, b) => a.at - b.at);
        },
        80_000,
      );
      const time = new ManualTime(recorded[0]!.at);
      let ring!: (reason: WorktreeSignalReason) => void;
      let hints = 0;
      const signals = new ContainerWorktreeSignals({
        installer: { support: async () => "supported", install: async () => undefined },
        context: () =>
          ({
            storage: {},
            agentTools: {
              issueWorktreeSignal: (callback: typeof ring) => {
                ring = callback;
                return { ...credential, revoke: () => undefined };
              },
            },
          }) as never,
        nowMs: time.now,
        delay: time.timerFactory.set,
        cancelDelay: time.timerFactory.clear,
        onWarning: () => undefined,
      });
      const watcher = signals.start({
        containerId: "container-1",
        onChange: () => {
          hints += 1;
        },
      });
      await flushMicrotasks();
      try {
        for (const event of recorded) {
          await time.advance(event.at - time.now());
          ring(event.reason);
        }
        await time.advance(CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS);
        const changes = recorded.filter((event) => event.reason === "change");
        const durationMs = recorded.at(-1)!.at - recorded[0]!.at;
        expect(durationMs).toBeGreaterThan(60_000);
        expect(changes.length).toBeGreaterThan(55);
        expect(changes.length).toBeLessThanOrEqual(Math.ceil(durationMs / 1_000) + 1);
        // A tail after the last 400 ms burst, rather than a dropped pending change.
        expect(changes.at(-1)!.at - recorded[0]!.at).toBeGreaterThan(61_600);
        expect(watcher.qualified).toBe(true);
        expect(signals.status().demotions).toEqual({});
        expect(hints).toBeLessThanOrEqual(
          Math.ceil(durationMs / CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS) + 1,
        );
      } finally {
        watcher.close();
      }
    },
    90_000,
  );

  scriptTest(
    "start writes a private config from stdin and launches the watcher",
    async () => {
      await withFakes("echo 'Watches established.' >&2; exit 1", async (dir, run) => {
        expect(await run("start", claudeStateSignalConfig(credential))).toBe(0);
        expect(readFileSync(join(dir, "config"), "utf8")).toBe(claudeStateSignalConfig(credential));
        expect(statSync(join(dir, "config")).mode & 0o777).toBe(0o600);
        // The fake setsid ran the watcher in the foreground: it rang and ended.
        expect(rings(dir)).toEqual(["lost", "ready"]);
        expect(await run("bogus")).toBe(2);
      });
    },
    30_000,
  );

  scriptTest(
    "without a readable config nothing rings",
    async () => {
      await withFakes(
        "echo 'Watches established.' >&2; echo 'E CREATE'; exit 1",
        async (dir, run) => {
          expect(await run("watch")).toBe(0);
          expect(rings(dir)).toEqual([]);
        },
      );
    },
    30_000,
  );
});
