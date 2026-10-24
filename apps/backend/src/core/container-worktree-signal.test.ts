import { describe, expect, test } from "bun:test";
import type { StateSignalCredential, WorktreeSignalReason } from "./agent-tools.js";
import {
  CONTAINER_WORKTREE_SIGNAL_MAX_RINGS_PER_MINUTE,
  CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS,
  CONTAINER_WORKTREE_SIGNAL_MISS_GRACE_MS,
  CONTAINER_WORKTREE_SIGNAL_RETRY_MS,
  ContainerWorktreeSignals,
  type ContainerWorktreeSignalSupport,
  type ContainerWorktreeWatcher,
} from "./container-worktree-signal.js";
import { ManualTime, deferred, flushMicrotasks } from "./recurring-test-support.js";
import type { WorktreeChangeHint } from "./worktree-watcher.js";

type Issued = {
  credential: StateSignalCredential;
  ring: (reason: WorktreeSignalReason) => void;
  revoked: boolean;
};

function harness(
  options: {
    support?: ContainerWorktreeSignalSupport[];
    install?: (credential: StateSignalCredential, isCurrent: () => boolean) => Promise<void>;
    /** No agent tools issuer: the context of a fixture without a server. */
    noIssuer?: boolean;
    listening?: () => boolean;
  } = {},
) {
  const time = new ManualTime(1_000_000);
  const issued: Issued[] = [];
  const supportAnswers = [...(options.support ?? ["supported"])];
  const installs: string[] = [];
  const warnings: string[] = [];
  const agentTools = {
    issueWorktreeSignal(ring: (reason: WorktreeSignalReason) => void) {
      if (options.listening && !options.listening()) return null;
      const entry: Issued = {
        credential: {
          url: "http://host.docker.internal:1/worktree-signal",
          token: `token-${issued.length + 1}`,
          revoke: () => {
            entry.revoked = true;
          },
        },
        ring,
        revoked: false,
      };
      issued.push(entry);
      return entry.credential;
    },
  };
  const signals = new ContainerWorktreeSignals({
    installer: {
      support: async () => supportAnswers.shift() ?? "supported",
      install: async (containerId, credential, _context, isCurrent) => {
        installs.push(`${containerId}:${credential.token}`);
        await options.install?.(credential, isCurrent);
      },
    },
    context: () =>
      ({
        storage: {},
        ...(options.noIssuer ? {} : { agentTools }),
      }) as never,
    nowMs: time.now,
    delay: (callback, delayMs) => time.setTimeout(callback, delayMs),
    cancelDelay: (timer) => time.clear(timer),
    onWarning: (message) => warnings.push(message),
  });
  const hints: WorktreeChangeHint[] = [];
  let coverageChanges = 0;
  const start = (containerId = "container-1"): ContainerWorktreeWatcher =>
    signals.start({
      containerId,
      onChange: (hint) => hints.push(hint!),
      onCoverageChange: () => {
        coverageChanges += 1;
      },
    });
  /** What the agent tools server does on a POST: ring an unrevoked credential. */
  const ring = (reason: WorktreeSignalReason, entry: Issued | undefined = issued.at(-1)) => {
    if (!entry || entry.revoked) return false;
    entry.ring(reason);
    return true;
  };
  return {
    time,
    signals,
    issued,
    installs,
    warnings,
    hints,
    start,
    ring,
    coverageChanges: () => coverageChanges,
  };
}

describe("container worktree signal", () => {
  test("a probe ring confirms the watcher and every ring becomes a full hint", async () => {
    const h = harness();
    const watcher = h.start();
    await flushMicrotasks();
    expect(watcher.watching).toBe(true);
    expect(watcher.qualified).toBe(false);
    expect(h.installs).toEqual(["container-1:token-1"]);
    expect(h.signals.status().states.armed).toBe(1);

    expect(h.ring("ready")).toBe(true);
    expect(watcher.qualified).toBe(true);
    expect(h.coverageChanges()).toBe(1);
    // Events before the confirmation were never announced: rescan at once.
    expect(h.hints).toEqual([{ fileList: true, tree: true, overflow: false }]);
    expect(h.signals.status()).toEqual({
      containers: 1,
      states: { unarmed: 0, arming: 0, armed: 0, confirmed: 1, demoted: 0, unsupported: 0 },
      fallback: 0,
      demotions: {},
      rings: 1,
    });
    watcher.close();
    expect(h.issued[0]!.revoked).toBe(true);
    expect(h.signals.status().containers).toBe(0);
  });

  test("rings within the gap collapse into one trailing hint that keeps an overflow", async () => {
    const h = harness();
    h.start();
    await flushMicrotasks();
    h.ring("ready");
    h.ring("change");
    h.ring("overflow");
    h.ring("change");
    expect(h.hints).toHaveLength(1);
    await h.time.advance(CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS);
    expect(h.hints).toEqual([
      { fileList: true, tree: true, overflow: false },
      { fileList: true, tree: true, overflow: true },
    ]);
    // After a quiet gap the next ring is forwarded at once.
    await h.time.advance(CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS);
    h.ring("change");
    expect(h.hints).toHaveLength(3);
    expect(h.hints[2]!.overflow).toBe(false);
  });

  test("a lost watcher demotes at once, rescans, and re-arms after the retry window", async () => {
    const h = harness();
    const watcher = h.start();
    await flushMicrotasks();
    h.ring("ready");
    expect(h.ring("lost")).toBe(true);
    expect(watcher.qualified).toBe(false);
    expect(h.issued[0]!.revoked).toBe(true);
    expect(h.coverageChanges()).toBe(2);
    expect(h.hints).toHaveLength(2);
    expect(h.signals.status().states.demoted).toBe(1);
    expect(h.signals.status().demotions).toEqual({ "watcher-lost": 1 });
    expect(h.warnings[0]).toContain("lost its watcher");

    await h.time.advance(CONTAINER_WORKTREE_SIGNAL_RETRY_MS - 1);
    expect(h.installs).toHaveLength(1);
    await h.time.advance(1);
    await flushMicrotasks();
    expect(h.installs).toEqual(["container-1:token-1", "container-1:token-2"]);
    h.ring("ready");
    expect(watcher.qualified).toBe(true);
  });

  test("an unannounced change demotes only when no ring follows within the grace", async () => {
    const h = harness();
    const watcher = h.start();
    await flushMicrotasks();
    h.ring("ready");

    // A ring still settling in the container arrives after the safety scan.
    watcher.unannouncedChange();
    await h.time.advance(CONTAINER_WORKTREE_SIGNAL_MISS_GRACE_MS - 1);
    h.ring("change");
    await h.time.advance(1);
    expect(watcher.qualified).toBe(true);

    watcher.unannouncedChange();
    await h.time.advance(CONTAINER_WORKTREE_SIGNAL_MISS_GRACE_MS);
    expect(watcher.qualified).toBe(false);
    expect(h.signals.status().demotions).toEqual({ "missed-change": 1 });
    expect(h.ring("change")).toBe(false);
  });

  test("a flood of rings demotes the lineage and its credential stops working", async () => {
    const h = harness();
    const watcher = h.start();
    await flushMicrotasks();
    for (let index = 0; index < CONTAINER_WORKTREE_SIGNAL_MAX_RINGS_PER_MINUTE; index += 1) {
      h.ring("change");
    }
    expect(watcher.qualified).toBe(true);
    h.ring("change");
    expect(watcher.qualified).toBe(false);
    expect(h.signals.status().demotions).toEqual({ "rang-too-often": 1 });
    expect(h.ring("change")).toBe(false);
  });

  test("an image without the capability keeps the container unwatched for its life", async () => {
    const h = harness({ support: ["unsupported"] });
    const first = h.start();
    await flushMicrotasks();
    expect(first.watching).toBe(false);
    expect(h.issued).toHaveLength(0);
    first.close();
    // A new lineage of the same container is not asked again.
    const second = h.start();
    await flushMicrotasks();
    expect(second.watching).toBe(false);
    expect(h.signals.status().states.unsupported).toBe(1);
  });

  test("an uninspectable image and a failed install retry after the window", async () => {
    const h = harness({
      support: ["unknown", "supported"],
      install: async () => {
        if (h.installs.length === 1) throw new Error("docker exec failed");
      },
    });
    const watcher = h.start();
    await flushMicrotasks();
    expect(h.issued).toHaveLength(0);
    expect(h.signals.status().states.unarmed).toBe(1);
    await h.time.advance(CONTAINER_WORKTREE_SIGNAL_RETRY_MS);
    await flushMicrotasks();
    expect(h.installs).toHaveLength(1);
    expect(h.issued[0]!.revoked).toBe(true);
    expect(h.signals.status().demotions).toEqual({ "arm-failed": 1 });
    expect(h.warnings.at(-1)).toContain("docker exec failed");
    await h.time.advance(CONTAINER_WORKTREE_SIGNAL_RETRY_MS);
    await flushMicrotasks();
    expect(h.installs).toHaveLength(2);
    h.ring("ready");
    expect(watcher.qualified).toBe(true);
  });

  test("an install whose ready ring never arrives is re-armed after the window", async () => {
    const h = harness();
    const watcher = h.start();
    await flushMicrotasks();
    expect(h.signals.status().states.armed).toBe(1);
    await h.time.advance(CONTAINER_WORKTREE_SIGNAL_RETRY_MS);
    await flushMicrotasks();
    expect(h.installs).toHaveLength(2);
    expect(h.issued[0]!.revoked).toBe(true);
    h.ring("ready");
    expect(watcher.qualified).toBe(true);
    // Once confirmed, the pending window re-arms nothing.
    await h.time.advance(CONTAINER_WORKTREE_SIGNAL_RETRY_MS * 2);
    await flushMicrotasks();
    expect(h.installs).toHaveLength(2);
  });

  test("a new lineage installs only after the previous one stopped, and old rings are void", async () => {
    const gate = deferred();
    const h = harness({
      install: async () => {
        if (h.installs.length === 1) await gate.promise;
      },
    });
    const first = h.start();
    await flushMicrotasks();
    first.close();
    const second = h.start();
    await flushMicrotasks();
    expect(h.installs).toHaveLength(1);
    gate.resolve();
    await flushMicrotasks();
    expect(h.installs).toEqual(["container-1:token-1", "container-1:token-2"]);
    expect(h.ring("ready", h.issued[0])).toBe(false);
    expect(second.qualified).toBe(false);
    h.ring("ready");
    expect(second.qualified).toBe(true);
  });

  test("a tracked lineage retries when the agent tools server starts listening later", async () => {
    let listening = false;
    const h = harness({ listening: () => listening });
    const watcher = h.start();
    await flushMicrotasks();
    expect(h.signals.status().states.unarmed).toBe(1);
    expect(h.installs).toHaveLength(0);
    listening = true;
    await h.time.advance(CONTAINER_WORKTREE_SIGNAL_RETRY_MS);
    await flushMicrotasks();
    expect(h.installs).toHaveLength(1);
    h.ring("ready");
    expect(watcher.qualified).toBe(true);
    watcher.close();
    await h.time.advance(CONTAINER_WORKTREE_SIGNAL_RETRY_MS * 2);
    expect(h.installs).toHaveLength(1);
  });

  test("without an agent tools issuer nothing is armed", async () => {
    const h = harness({ noIssuer: true });
    const watcher = h.start();
    await flushMicrotasks();
    expect(watcher.watching).toBe(true);
    expect(watcher.qualified).toBe(false);
    expect(h.installs).toHaveLength(0);
    expect(h.signals.status().states.unarmed).toBe(1);
  });
});
