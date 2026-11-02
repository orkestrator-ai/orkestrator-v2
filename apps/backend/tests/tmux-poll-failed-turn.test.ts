/**
 * A container Claude CLI turn that ends on an API error (to-do 1200).
 *
 * `StopFailure` runs instead of `Stop`, and its hook calls
 * `orkestrator-state-signal failed`. These tests run the real hook script on
 * the host against a temporary state file, feed the snapshot it writes to the
 * real poll, and persist through real storage, so the whole path from the hook
 * to the `agent_failed` bell is covered without a container.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageService } from "../src/core/storage.js";
import {
  CLAUDE_STATE_ABSENT_MARKER,
  CLAUDE_STATE_POLL_INTERVAL_MS,
  ClaudeStatePollManager,
} from "../src/core/tmux-poll.js";
import { ManualTime, flushMicrotasks } from "../src/core/recurring-test-support.js";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures.js";

const SCRIPT = join(import.meta.dir, "../../../docker/orkestrator-state-signal.sh");
const CONTAINER = "container-failed-turn";

let dir: string;
let stateFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ork-failed-turn-"));
  stateFile = join(dir, "state");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** One hook, exactly as the entrypoint runs it, with no doorbell config. */
function hook(state: "working" | "waiting" | "failed"): void {
  const result = spawnSync("sh", [SCRIPT, state], {
    env: {
      ...process.env,
      ORKESTRATOR_STATE_FILE: stateFile,
      ORKESTRATOR_STATE_SIGNAL_CONFIG: join(dir, "absent"),
    },
  });
  expect(result.status).toBe(0);
}

/** The production read: the snapshot, else the legacy file, else absent. */
function readState(): string {
  const snapshot = `${stateFile}-snapshot`;
  if (existsSync(snapshot)) return readFileSync(snapshot, "utf8");
  if (existsSync(stateFile)) return readFileSync(stateFile, "utf8");
  return CLAUDE_STATE_ABSENT_MARKER;
}

async function harness() {
  const storage = new StorageService(join(dir, "data"));
  await storage.init();
  const environment = lifecycleEnvironment({ containerId: CONTAINER, status: "running" });
  await storage.addEnvironment(environment);
  const { context } = memoryLifecycleContext([environment], join(dir, "data"));
  context.storage = storage;
  const emitted: string[] = [];
  context.emit = (_event, payload) => {
    emitted.push((payload as { state: string }).state);
  };
  context.probeAgentCreatedPullRequest = async () => undefined;
  const time = new ManualTime(Date.now());
  const manager = new ClaudeStatePollManager({
    readState: async () => readState(),
    nowMs: time.now,
    now: () => new Date(time.now()).toISOString(),
    schedule: time.setInterval.bind(time),
    cancel: time.clear.bind(time),
  });
  const tick = async () => {
    await time.advance(CLAUDE_STATE_POLL_INTERVAL_MS);
    await flushMicrotasks();
  };
  const read = async () => (await storage.getEnvironment(environment.id))!;
  const markRead = () =>
    storage.updateEnvironment(environment.id, { hasUnreadWork: false, unreadReason: undefined });
  return {
    start: async () => {
      manager.start(CONTAINER, context);
      await flushMicrotasks();
    },
    stop: () => manager.shutdown(CONTAINER),
    tick,
    read,
    markRead,
    emitted,
  };
}

describe("orkestrator-state-signal failed", () => {
  test("counts a revision but no completion, and tells older backends idle", () => {
    hook("working");
    hook("failed");
    expect(readFileSync(`${stateFile}-snapshot`, "utf8").trim()).toBe("failed 2 0");
    expect(readFileSync(stateFile, "utf8").trim()).toBe("idle");
    // The next prompt starts from a failed snapshot, and its Stop still counts.
    hook("working");
    hook("waiting");
    expect(readFileSync(`${stateFile}-snapshot`, "utf8").trim()).toBe("waiting 4 1");
    // A StopFailure after a finished turn (or a second one) is not a completion.
    hook("failed");
    hook("failed");
    expect(readFileSync(`${stateFile}-snapshot`, "utf8").trim()).toBe("failed 6 1");
  });

  test("an unknown state word changes nothing, as an older script treats failed", () => {
    hook("working");
    const result = spawnSync("sh", [SCRIPT, "exploded"], {
      env: { ...process.env, ORKESTRATOR_STATE_FILE: stateFile },
    });
    expect(result.status).toBe(0);
    expect(readFileSync(`${stateFile}-snapshot`, "utf8").trim()).toBe("working 1 0");
  });
});

describe("Claude terminal poll after a failed turn", () => {
  test("a failed turn stops reading working and rings agent_failed", async () => {
    const h = await harness();
    hook("waiting");
    await h.start();
    hook("working");
    await h.tick();
    expect((await h.read()).agentActivitySources?.["claude-terminal"]?.state).toBe("working");
    await h.markRead();

    hook("failed");
    await h.tick();
    const environment = await h.read();
    expect(environment.agentActivitySources?.["claude-terminal"]?.state).toBe("idle");
    expect(environment.agentActivityState).toBe("idle");
    expect(environment.hasUnreadWork).toBe(true);
    expect(environment.unreadReason).toBe("agent_failed");
    expect(h.emitted.at(-1)).toBe("idle");
    h.stop();
  });

  test("a normal Stop still rings as it did", async () => {
    const h = await harness();
    hook("waiting");
    await h.start();
    hook("working");
    await h.tick();
    await h.markRead();

    hook("waiting");
    await h.tick();
    const environment = await h.read();
    expect(environment.agentActivitySources?.["claude-terminal"]?.state).toBe("waiting");
    expect(environment.hasUnreadWork).toBe(true);
    expect(environment.unreadReason).toBe("agent_waiting");
    h.stop();
  });

  test("a failed turn whose working edge was never read still rings agent_failed", async () => {
    const h = await harness();
    hook("waiting");
    await h.start();
    await h.tick();
    await h.markRead();

    // Both hooks between two reads: the poll only ever sees the failure.
    hook("working");
    hook("failed");
    await h.tick();
    const environment = await h.read();
    expect(environment.agentActivitySources?.["claude-terminal"]?.state).toBe("idle");
    expect(environment.hasUnreadWork).toBe(true);
    expect(environment.unreadReason).toBe("agent_failed");

    // Re-reading the same snapshot rings nothing more.
    await h.markRead();
    await h.tick();
    await h.tick();
    expect((await h.read()).hasUnreadWork).toBe(false);
    h.stop();
  });

  test("a failure already on disk at backend start rings from the persisted working source", async () => {
    const h = await harness();
    hook("waiting");
    await h.start();
    hook("working");
    await h.tick();
    h.stop();
    await h.markRead();

    // The turn fails while no poll is running; a new poll's first read finds it.
    hook("failed");
    await h.start();
    await h.tick();
    const environment = await h.read();
    expect(environment.agentActivitySources?.["claude-terminal"]?.state).toBe("idle");
    expect(environment.unreadReason).toBe("agent_failed");
    expect(environment.hasUnreadWork).toBe(true);
    h.stop();
  });
});
