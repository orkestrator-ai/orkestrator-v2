import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { CommandContext } from "./commands.js";
import { TmuxBackend } from "./tmux-backend.js";
import type { TmuxHookDoorbell } from "./tmux-hook-signal.js";
import { TMUX_HOOK_DOORBELL_COMMAND, hookScript, workspaceHookPaths } from "./tmux-hooks.js";
import { TmuxSession, TmuxSessionManager } from "./tmux-session-manager.js";
import {
  POLL_INTERVAL_MS,
  TMUX_IDLE_AFTER_QUIET_TICKS,
  TMUX_SIGNALLED_IDLE_INTERVAL_MS,
  type PollSnapshotExtras,
  type TmuxPollSnapshot,
} from "./tmux-shared.js";

const settle = async () => {
  for (let index = 0; index < 10; index += 1) await new Promise((r) => setImmediate(r));
};

/**
 * A container tab's poll loop driven tick by tick, with a stub doorbell and a
 * stubbed snapshot, so every wait the loop asks for and every exec it issues
 * outside the snapshot is visible.
 */
function harness(options: { confirmed?: boolean } = {}) {
  let now = 1_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const waits: Array<{ intervalMs: number; resolve: () => void }> = [];
  const backend = TmuxBackend.container("c".repeat(64));
  const sessions = new TmuxSessionManager();
  const session = new TmuxSession(
    "env",
    "tab",
    backend,
    "/tmp/ork-doorbell",
    "resumed-id",
    undefined,
    {
      pollTick: (intervalMs) => new Promise<void>((resolve) => waits.push({ intervalMs, resolve })),
    },
  );
  sessions.insert("env", "tab", session);
  let rings = 0;
  let confirmed = options.confirmed ?? true;
  let ringListener: (() => void) | undefined;
  const missed = mock(() => {
    confirmed = false;
  });
  const released = mock(() => undefined);
  const doorbell: TmuxHookDoorbell = {
    rings: () => rings,
    confirmed: () => confirmed,
    missed,
    release: released,
  };
  const snapshots: Array<PollSnapshotExtras & { at: number }> = [];
  let next: Partial<TmuxPollSnapshot> = {};
  let alive = true;
  const snapshot = spyOn(backend, "pollSnapshot").mockImplementation(
    async (_paths, _transcript, extras = {}) => {
      snapshots.push({ ...extras, at: now });
      const answer: TmuxPollSnapshot = {
        pending: [],
        timeouts: [],
        transcriptSize: 0,
        ...(extras.candidatePath ? { candidateSize: null } : {}),
        ...(extras.tmux?.liveness ? { alive } : {}),
        ...(extras.tmux?.pane ? { pane: "> \n" } : {}),
        ...next,
      };
      next = {};
      return answer;
    },
  );
  const exec = spyOn(backend, "exec").mockImplementation(async () => ({
    status: alive ? 0 : 1,
    stdout: "",
    stderr: "",
  }));
  spyOn(backend, "removeDir").mockResolvedValue(undefined);
  spyOn(backend, "removeFile").mockResolvedValue(undefined);
  spyOn(session, "discoverTranscriptPath").mockResolvedValue(undefined);
  const emitted: Array<Record<string, unknown>> = [];
  const context = {
    emit: (_event: string, payload: Record<string, unknown>) => emitted.push(payload),
    storage: {},
    runtime: {
      tmux: {
        sessions,
        persistEnvironmentActivity: async () => undefined,
        hookSignals: {
          attach: (_id: string, _context: unknown, onRing: () => void) => {
            ringListener = onRing;
            return doorbell;
          },
        },
      },
    },
  } as unknown as CommandContext;

  /**
   * Lets the loop's current wait end by its timer, at its own due time. Only
   * the newest wait is live: a woken wait leaves its timer behind.
   */
  const elapse = async () => {
    const wait = waits.pop();
    waits.length = 0;
    if (!wait) throw new Error("the loop is not waiting");
    now += wait.intervalMs;
    wait.resolve();
    await settle();
    return wait.intervalMs;
  };
  return {
    session,
    sessions,
    snapshots,
    emitted,
    exec,
    missed,
    released,
    waits,
    context,
    advance: (ms: number) => {
      now += ms;
    },
    setNext: (value: Partial<TmuxPollSnapshot>) => {
      next = value;
    },
    setAlive: (value: boolean) => {
      alive = value;
    },
    ring: async () => {
      rings += 1;
      ringListener?.();
      await settle();
    },
    elapse,
    start: async () => {
      (session as unknown as { spawnPollLoop(context: CommandContext): void }).spawnPollLoop(
        context,
      );
      await settle();
    },
    /** Runs the fast ticks after start until the loop is idle. */
    reachIdle: async () => {
      for (let tick = 0; tick < TMUX_IDLE_AFTER_QUIET_TICKS; tick += 1) await elapse();
    },
    restore: () => {
      (session as unknown as { stopRequested: boolean }).stopRequested = true;
      for (const wait of waits.splice(0)) wait.resolve();
      clock.mockRestore();
      snapshot.mockRestore();
      exec.mockRestore();
    },
  };
}

let active: ReturnType<typeof harness> | undefined;
afterEach(async () => {
  active?.restore();
  await settle();
  active = undefined;
});

describe("tmux poll loop with a hook doorbell", () => {
  test("an idle tab sleeps to the safety read, and that read carries liveness and the pane", async () => {
    const h = (active = harness());
    await h.start();
    await h.reachIdle();
    expect(h.waits.at(-1)?.intervalMs).toBe(TMUX_SIGNALLED_IDLE_INTERVAL_MS);
    const before = h.snapshots.length;
    await h.elapse();
    expect(h.snapshots).toHaveLength(before + 1);
    expect(h.snapshots.at(-1)?.tmux).toMatchObject({ liveness: true, pane: true });
    // Nothing else is exec'd: liveness and the pane rode in the snapshot.
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.session.recentLiveness(1_000)).toBe(true);
  });

  test("a ring reads at once, but never sooner than the fast cadence after the last read", async () => {
    const h = (active = harness());
    await h.start();
    await h.reachIdle();
    await h.elapse(); // a safety read just ran
    const reads = h.snapshots.length;
    await h.ring();
    // Woken, then held for the rest of the minimum gap.
    expect(h.waits.at(-1)?.intervalMs).toBe(POLL_INTERVAL_MS);
    await h.elapse();
    expect(h.snapshots).toHaveLength(reads + 1);

    // A ring long after the last read is served with no extra wait.
    expect(h.waits.at(-1)?.intervalMs).toBe(TMUX_SIGNALLED_IDLE_INTERVAL_MS);
    h.advance(1_000);
    await h.ring();
    expect(h.snapshots).toHaveLength(reads + 2);
  });

  test("a hook file no ring announced demotes the doorbell", async () => {
    const h = (active = harness());
    await h.start();
    await h.reachIdle();
    h.setNext({ pending: ["PostToolUse-1-2.json"] });
    await h.elapse(); // safety read finds it, unannounced
    expect(h.missed).not.toHaveBeenCalled();
    await h.elapse(); // still no ring a read later
    expect(h.missed).toHaveBeenCalledTimes(1);
  });

  test("a late ring for a hook the safety read already saw is not a miss", async () => {
    const h = (active = harness());
    await h.start();
    await h.reachIdle();
    h.setNext({ pending: ["PostToolUse-1-2.json"] });
    await h.elapse();
    await h.ring();
    await h.elapse();
    expect(h.missed).not.toHaveBeenCalled();
  });

  test("without a confirmed doorbell an idle tab keeps the one-second poll in one exec", async () => {
    const h = (active = harness({ confirmed: false }));
    await h.start();
    await h.reachIdle();
    expect(h.waits.at(-1)?.intervalMs).toBe(1_000);
    for (let tick = 0; tick < 6; tick += 1) await h.elapse();
    expect(h.exec).not.toHaveBeenCalled();
    // Liveness every second idle tick, folded into that tick's snapshot.
    expect(h.snapshots.slice(-6).filter((s) => s.tmux?.liveness)).toHaveLength(3);
  });

  test("a stopped container makes every tab in it check liveness now and retire", async () => {
    const h = (active = harness());
    await h.start();
    await h.reachIdle();
    h.setAlive(false);
    expect(h.sessions.containerEnded("c".repeat(12))).toBe(1);
    await settle();
    await h.elapse(); // the minimum gap after the wake
    expect(h.snapshots.at(-1)?.tmux?.liveness).toBe(true);
    expect(h.emitted.some((payload) => payload.kind === "stopped")).toBe(true);
    expect(h.sessions.get("env", "tab")).toBeUndefined();
    expect(h.released).toHaveBeenCalledTimes(1);
  });

  test("a snapshot binds the transcript named after the session as soon as it exists", async () => {
    const h = (active = harness());
    await h.start();
    await h.elapse();
    expect(h.snapshots[0]?.candidatePath).toBe(h.session.expectedTranscriptPath());
    h.setNext({ candidateSize: 0 });
    await h.elapse();
    await h.elapse();
    expect(h.snapshots.at(-1)?.candidatePath).toBeUndefined();
    expect(h.session.status(true).transcript_path).toBe(h.session.expectedTranscriptPath());
  });
});

describe("tmux hook script doorbell", () => {
  const workspace = workspaceHookPaths("/tmp/ork-root", "/workspace");

  test("a container hook rings after each hook file it writes, and never fails the hook", () => {
    const script = hookScript(workspace, { doorbell: true });
    const lines = script.split("\n").map((line) => line.trim());
    const rings = lines.flatMap((line, index) => (line === "ring_doorbell" ? [index] : []));
    expect(rings).toHaveLength(3);
    // Each ring follows the write it announces: two pending files and a timeout.
    expect(lines[rings[0]! - 1]).toBe(`printf '%s' "$PAYLOAD" > "$PENDING_FILE"`);
    expect(lines[rings[1]! - 1]).toBe(
      `rm -f "$PENDING_FILE" "$TIMING_FILE" "$TIMING_TMP" "$HOLD_FILE"`,
    );
    expect(lines[rings[2]! - 1]).toBe(`printf '%s' "$PAYLOAD" > "$PENDING_FILE"`);
    expect(script).toContain(
      `if [ -x ${TMUX_HOOK_DOORBELL_COMMAND} ]; then ${TMUX_HOOK_DOORBELL_COMMAND} hook </dev/null >/dev/null 2>&1 || true; fi`,
    );
  });

  test("a host hook has no doorbell", () => {
    expect(hookScript(workspace)).not.toContain(TMUX_HOOK_DOORBELL_COMMAND);
  });
});
