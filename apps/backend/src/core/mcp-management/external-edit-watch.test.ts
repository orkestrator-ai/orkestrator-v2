import { describe, expect, mock, test } from "bun:test";

import type { CurrentSourceState } from "./evidence.js";
import { ExternalEditWatch } from "./external-edit-watch.js";
import { MERGED_NOTE } from "./external-edits.js";
import type { StoredOperation } from "./operations-store.js";

const NOW = Date.parse("2026-09-23T12:00:00Z");

function operation(): StoredOperation {
  const at = new Date(NOW).toISOString();
  return {
    snapshot: {
      operationId: "operation",
      requestId: "request",
      targetId: "target",
      provider: "opencode",
      kind: "add",
      entryName: "fixture",
      sourceId: "opencode:user-opencode.json",
      phase: "saved",
      applyIntent: "save-and-apply",
      apply: {
        state: "restart-required",
        runtimes: [
          {
            runtimeId: "runtime",
            environmentId: "e",
            label: "fixture",
            state: "restart-required",
            updatedAt: at,
          },
        ],
        omitted: 0,
      },
      createdAt: at,
      updatedAt: at,
    },
    recovery: {
      fingerprint: "fingerprint",
      expectedRevision: null,
      name: "fixture",
      savedEntriesDigest: "saved",
      applyQueuedAt: at,
    },
  };
}

describe("ExternalEditWatch", () => {
  test.each(["cancelled", "queued"] as const)(
    "a plan replaced with %s while reading cannot be retired or annotated by that read",
    async (state) => {
      // Exercise both paths that could otherwise commit an obsolete source read.
      for (const landed of [false, true]) {
        const stored = operation();
        let finishRead!: (current: CurrentSourceState) => void;
        const currentSource = mock(
          () => new Promise<CurrentSourceState>((resolve) => (finishRead = resolve)),
        );
        const commit = mock(async () => {});
        const watch = new ExternalEditWatch({
          now: () => NOW,
          blocked: () => false,
          currentSource,
          commit,
        });
        const checking = watch.check([stored]);
        expect(currentSource).toHaveBeenCalledTimes(1);
        stored.snapshot.apply.runtimes = stored.snapshot.apply.runtimes.map((runtime) => ({
          ...runtime,
          state,
        }));
        stored.snapshot.apply.state = state;
        finishRead({ digest: "current", landed, entriesDigest: "changed" });
        await checking;
        expect(stored.snapshot.apply.runtimes[0]!.state).toBe(state);
        expect(stored.snapshot.apply.runtimes[0]!.cancelReason).toBeUndefined();
        expect(stored.snapshot.message).toBeUndefined();
        expect(commit).not.toHaveBeenCalled();
      }
    },
  );

  test("a provider blocked by rollout is neither scheduled nor read, and resumes when enabled", async () => {
    const stored = operation();
    let blocked = true;
    const currentSource = mock(async () => ({
      digest: "current",
      landed: true,
      entriesDigest: "changed",
    }));
    const commit = mock(async () => {});
    const watch = new ExternalEditWatch({
      now: () => NOW,
      blocked: (provider) => blocked && provider === "opencode",
      currentSource,
      commit,
    });
    expect(watch.hasWork([stored])).toBe(false);
    await watch.check([stored]);
    expect(currentSource).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    blocked = false;
    expect(watch.hasWork([stored])).toBe(true);
    await watch.check([stored]);
    expect(currentSource).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(stored);
    expect(stored.snapshot.message).toBe(MERGED_NOTE);
  });
});
