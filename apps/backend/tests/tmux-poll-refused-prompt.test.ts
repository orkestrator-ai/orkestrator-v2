/**
 * Container Claude CLI turns no hook ends (#2315).
 *
 * After a refused login the CLI answers the next prompt "Not logged in ·
 * Please run /login" locally: `UserPromptSubmit` rang `working`, and neither
 * `Stop` nor `StopFailure` follows. Closing the tab mid-turn leaves the same
 * `working` behind. These tests run the real hook script and the real settle
 * script on the host against a temporary state file, feed the snapshot to the
 * real poll with a real `TerminalRuntime` holding the tab's output, and
 * persist through real storage, so the path from the CLI's notice to the bell
 * is covered without a container.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_SIGN_IN_NOTICE_QUIET_MS,
  CLAUDE_STATE_SETTLE_SCRIPT,
  type ClaudeStateSettler,
} from "../src/core/claude-terminal-settle.js";
import type { PtyProcess } from "../src/core/pty.js";
import { StorageService } from "../src/core/storage.js";
import { TerminalRuntime } from "../src/core/terminal-runtime.js";
import {
  CLAUDE_STATE_ABSENT_MARKER,
  CLAUDE_STATE_POLL_INTERVAL_MS,
  ClaudeStatePollManager,
} from "../src/core/tmux-poll.js";
import { ManualTime, flushMicrotasks } from "../src/core/recurring/test-support.js";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures.js";

const HOOK = join(import.meta.dir, "../../../docker/orkestrator-state-signal.sh");
const CONTAINER = "container-refused-prompt";
const NOTICE = "\x1b[38;5;246m  ⎿  \x1b[38;5;211mNot logged in · Please run /login\r\x1b[2B";
const hasFlock = spawnSync("sh", ["-c", "command -v flock"]).status === 0;

let dir: string;
let stateFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ork-refused-prompt-"));
  stateFile = join(dir, "state");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const scriptEnv = () => ({
  ...process.env,
  ORKESTRATOR_STATE_FILE: stateFile,
  ORKESTRATOR_STATE_SIGNAL_CONFIG: join(dir, "absent"),
});

/** One hook, exactly as the entrypoint runs it, with no doorbell config. */
function hook(state: "working" | "waiting" | "failed"): void {
  expect(spawnSync("sh", [HOOK, state], { env: scriptEnv() }).status).toBe(0);
}

/** The settle the backend runs with `docker exec`, run by the host's `sh`. */
const localSettler: ClaudeStateSettler = async (_containerId, expected, target) => {
  const result = spawnSync(
    "sh",
    [
      "-c",
      CLAUDE_STATE_SETTLE_SCRIPT,
      "sh",
      String(expected.revision),
      String(expected.completions),
      target,
    ],
    { env: scriptEnv(), encoding: "utf8" },
  );
  return result.stdout.trim() === "settled";
};

function snapshot(): string {
  return readFileSync(`${stateFile}-snapshot`, "utf8").trim();
}

/** The production read: the snapshot, else the legacy file, else absent. */
function readState(): string {
  const path = `${stateFile}-snapshot`;
  if (existsSync(path)) return readFileSync(path, "utf8");
  if (existsSync(stateFile)) return readFileSync(stateFile, "utf8");
  return CLAUDE_STATE_ABSENT_MARKER;
}

async function harness(
  options: { settle?: ClaudeStateSettler | null; read?: () => Promise<string> } = {},
) {
  const storage = new StorageService(join(dir, "data"));
  await storage.init();
  const environment = lifecycleEnvironment({ containerId: CONTAINER, status: "running" });
  await storage.addEnvironment(environment);
  const { context } = memoryLifecycleContext([environment], join(dir, "data"));
  context.storage = storage;
  const attention: string[] = [];
  storage.addEnvironmentAttentionListener((event) => attention.push(event.reason));
  context.emit = () => undefined;
  context.probeAgentCreatedPullRequest = async () => undefined;
  const terminals = new TerminalRuntime({ outputRetentionMs: 60_000 });
  terminals.rememberSession("tab", {
    kind: "container",
    containerId: CONTAINER,
    cols: 80,
    rows: 24,
  });
  terminals.registerProcess("tab", { kill: () => undefined } as unknown as PtyProcess);
  const time = new ManualTime(Date.now());
  const manager = new ClaudeStatePollManager({
    readState: options.read ?? (async () => readState()),
    nowMs: time.now,
    now: () => new Date(time.now()).toISOString(),
    schedule: time.setInterval.bind(time),
    cancel: time.clear.bind(time),
    ...(options.settle === null ? {} : { settle: options.settle ?? localSettler }),
    screens: () => terminals,
  });
  const tick = async (ms = CLAUDE_STATE_POLL_INTERVAL_MS) => {
    await time.advance(ms);
    await flushMicrotasks();
    await flushMicrotasks();
  };
  const read = async () => (await storage.getEnvironment(environment.id))!;
  const markRead = () =>
    storage.updateEnvironment(environment.id, { hasUnreadWork: false, unreadReason: undefined });
  return {
    start: async (demand = true) => {
      manager.start(CONTAINER, context, demand);
      await flushMicrotasks();
    },
    /** A new poll lineage for the same container, as after a backend restart. */
    restart: async () => {
      manager.shutdown(CONTAINER);
      manager.start(CONTAINER, context, true);
      await flushMicrotasks();
    },
    stop: () => {
      manager.shutdownAll();
      terminals.shutdown();
      expect(time.pendingTimers).toBe(0);
    },
    print: (text: string) => terminals.appendOutput("tab", text),
    tick,
    read,
    markRead,
    attention,
    status: () => manager.status(),
  };
}

/** A failed turn, read and acknowledged: where the to-do's next prompt starts. */
async function afterRefusedTurn(h: Awaited<ReturnType<typeof harness>>) {
  hook("working");
  await h.start();
  h.print("❯ Reply with only the word REFUSE_QA_401.\r\n");
  h.print(NOTICE);
  hook("failed");
  await h.tick();
  expect(snapshot()).toBe("failed 2 0");
  expect((await h.read()).agentActivityState).toBe("idle");
  await h.markRead();
  h.attention.length = 0;
}

describe.skipIf(!hasFlock)("a prompt the Claude CLI refuses locally", () => {
  test("its sign-in notice settles the turn failed and rings agent_failed", async () => {
    const h = await harness();
    await afterRefusedTurn(h);

    h.print("❯ Reply with only the word PONG.\r\n");
    hook("working");
    await h.tick();
    expect((await h.read()).agentActivityState).toBe("working");
    // The CLI prints the notice at once and then nothing: no hook follows.
    h.print(NOTICE);
    h.print("❯ ");
    for (let elapsed = 0; elapsed < CLAUDE_SIGN_IN_NOTICE_QUIET_MS; elapsed += 1_000) {
      await h.tick();
      expect(snapshot()).toBe("working 3 0");
    }
    await h.tick();
    await h.tick();
    expect(snapshot()).toBe("failed 4 0");
    const environment = await h.read();
    expect(environment.agentActivitySources?.["claude-terminal"]?.state).toBe("idle");
    expect(environment.agentActivityState).toBe("idle");
    expect(environment.hasUnreadWork).toBe(true);
    expect(environment.unreadReason).toBe("agent_failed");
    expect(h.attention).toEqual(["agent_failed"]);

    // The next prompt is an ordinary turn again.
    await h.markRead();
    hook("working");
    await h.tick();
    expect((await h.read()).agentActivityState).toBe("working");
    hook("waiting");
    await h.tick();
    expect((await h.read()).unreadReason).toBe("agent_waiting");
    expect(h.status().demotions).toEqual({});
    h.stop();
  });

  test("a turn that keeps printing is left working whatever it prints", async () => {
    const h = await harness();
    await afterRefusedTurn(h);
    hook("working");
    await h.tick();
    // The model quoting the notice, with the spinner still animating.
    h.print("Not logged in · Please run /login");
    for (let elapsed = 0; elapsed < 20_000; elapsed += 1_000) {
      h.print("\r✻ Working… (esc to interrupt)");
      await h.tick();
    }
    expect(snapshot()).toBe("working 3 0");
    expect((await h.read()).agentActivityState).toBe("working");
    expect(h.attention).toEqual([]);
    h.stop();
  });

  test("the previous turn's notice does not settle the next prompt", async () => {
    const h = await harness();
    await afterRefusedTurn(h);
    hook("working");
    await h.tick();
    h.print("❯ a prompt the model is still thinking about\r\n");
    await h.tick(30_000);
    expect(snapshot()).toBe("working 3 0");
    expect((await h.read()).agentActivityState).toBe("working");
    h.stop();
  });

  test("a prompt submitted while the settle runs is never overwritten", async () => {
    let raced = false;
    const h = await harness({
      settle: async (containerId, expected, target) => {
        if (!raced) {
          raced = true;
          hook("working");
        }
        return localSettler(containerId, expected, target);
      },
    });
    await afterRefusedTurn(h);
    hook("working");
    await h.tick();
    h.print(NOTICE);
    for (let elapsed = 0; elapsed <= CLAUDE_SIGN_IN_NOTICE_QUIET_MS; elapsed += 1_000) {
      await h.tick();
    }
    expect(raced).toBe(true);
    expect(snapshot()).toBe("working 4 0");
    // The new prompt stays quiet; the consumed notice must not be replayed.
    for (let elapsed = 0; elapsed < 15_000; elapsed += 1_000) {
      await h.tick();
    }
    expect(snapshot()).toBe("working 4 0");
    expect((await h.read()).agentActivityState).toBe("working");
    expect(h.attention).toEqual([]);
    h.stop();
  });

  test("without a settler the poll never writes to the container", async () => {
    const h = await harness({ settle: null });
    await afterRefusedTurn(h);
    hook("working");
    await h.tick();
    h.print(NOTICE);
    await h.tick(CLAUDE_SIGN_IN_NOTICE_QUIET_MS + 10_000);
    expect(snapshot()).toBe("working 3 0");
    h.stop();
  });
});

describe.skipIf(!hasFlock)("closing the last terminal mid-turn", () => {
  test("settles the turn idle without a bell, and it stays settled", async () => {
    const h = await harness();
    hook("working");
    hook("waiting");
    await h.start();
    hook("working");
    await h.tick();
    expect((await h.read()).agentActivityState).toBe("working");
    await h.markRead();
    h.attention.length = 0;

    // The tab closes: no terminal or claude-tmux tab is left in the container.
    await h.start(false);
    await h.tick();
    expect(snapshot()).toBe("idle 4 1");
    const environment = await h.read();
    expect(environment.agentActivitySources?.["claude-terminal"]?.state).toBe("idle");
    expect(environment.agentActivityState).toBe("idle");
    expect(environment.hasUnreadWork).toBe(false);
    expect(h.attention).toEqual([]);

    // A later poll lineage (the next run, a backend restart) reads idle too.
    await h.restart();
    await h.tick();
    expect((await h.read()).agentActivityState).toBe("idle");
    hook("working");
    await h.tick();
    expect(snapshot()).toBe("working 5 1");
    expect((await h.read()).agentActivityState).toBe("working");
    h.stop();
  });

  test("a terminal that is still open keeps the turn working", async () => {
    const h = await harness();
    hook("working");
    await h.start();
    await h.tick();
    await h.start(true);
    await h.tick(30_000);
    expect(snapshot()).toBe("working 1 0");
    expect((await h.read()).agentActivityState).toBe("working");
    h.stop();
  });
});

describe.skipIf(!hasFlock)("deferred recovery ordering", () => {
  test("retained refusal before the first read settles exactly once", async () => {
    let release!: (value: string) => void;
    let first = true;
    const h = await harness({
      read: () => {
        if (!first) return Promise.resolve(readState());
        first = false;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    hook("working");
    h.print(NOTICE);
    await h.start();
    release(readState());
    await flushMicrotasks();
    await h.tick(10_000);
    expect(snapshot()).toBe("failed 2 0");
    expect(h.attention).toEqual(["agent_failed"]);
    h.stop();
  });

  test("a notice during a non-working read is retained for the next working read", async () => {
    let release!: (value: string) => void;
    let defer = false;
    const h = await harness({
      read: () =>
        defer
          ? new Promise((resolve) => {
              defer = false;
              release = resolve;
            })
          : Promise.resolve(readState()),
    });
    hook("working");
    hook("failed");
    await h.start();
    defer = true;
    await h.tick();
    hook("working");
    h.print(NOTICE);
    release("failed 2 0");
    await flushMicrotasks();
    await h.tick(10_000);
    expect(snapshot()).toBe("failed 4 0");
    expect(h.attention.filter((x) => x === "agent_failed")).toHaveLength(1);
    h.stop();
  });

  for (const failure of ["false", "reject"] as const) {
    test("absent demand retries a " + failure + " idle settle", async () => {
      let calls = 0;
      const h = await harness({
        settle: async (...args) => {
          if (++calls === 1) {
            if (failure === "reject") throw new Error("test failure");
            return false;
          }
          return localSettler(...args);
        },
      });
      hook("working");
      await h.start(false);
      await h.tick(65_000);
      expect(snapshot()).toBe("idle 2 0");
      expect(h.attention).toEqual([]);
      h.stop();
    });
  }

  test("demand lost before the working read returns settles silently", async () => {
    let release!: (value: string) => void;
    let first = true;
    const h = await harness({
      read: () => {
        if (!first) return Promise.resolve(readState());
        first = false;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    hook("working");
    await h.start();
    await h.start(false);
    release(readState());
    await flushMicrotasks();
    await h.tick(35_000);
    expect(snapshot()).toBe("idle 2 0");
    expect(h.attention).toEqual([]);
    h.stop();
  });

  test("idle snapshot readable before settle resolves cannot ring finished", async () => {
    let release!: () => void;
    const h = await harness({
      settle: async (...args) => {
        const wrote = await localSettler(...args);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return wrote;
      },
    });
    hook("working");
    await h.start();
    await h.start(false);
    expect(snapshot()).toBe("idle 2 0");
    await h.tick(30_000);
    expect(h.attention).toEqual([]);
    release();
    await flushMicrotasks();
    await h.tick(30_000);
    expect((await h.read()).agentActivityState).toBe("idle");
    expect(h.attention).toEqual([]);
    h.stop();
  });

  test("demand loss during a refused settle reconciles the newer working revision", async () => {
    let release!: () => void;
    let first = true;
    const h = await harness({
      settle: async (...args) => {
        if (first) {
          first = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return localSettler(...args);
      },
    });
    hook("working");
    await h.start();
    h.print(NOTICE);
    await h.tick(4_000);
    hook("working");
    await h.start(false);
    release();
    await flushMicrotasks();
    await h.tick(65_000);
    expect(snapshot()).toBe("idle 3 0");
    expect(h.attention).toEqual([]);
    h.stop();
  });

  test("failed notice settles retry on the next watch check", async () => {
    let calls = 0;
    const h = await harness({
      settle: async (...args) => {
        if (++calls === 1) throw new Error("test failure");
        if (calls === 2) return false;
        return localSettler(...args);
      },
    });
    hook("working");
    await h.start();
    h.print(NOTICE);
    await h.tick(10_000);
    expect(snapshot()).toBe("failed 2 0");
    expect(h.attention).toEqual(["agent_failed"]);
    h.stop();
  });
});
