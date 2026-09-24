import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import type { DesignFrame } from "@orkestrator/protocol/design-canvas";
import type { DesignFailure } from "@orkestrator/protocol/design-operations";
import { invoke } from "@/lib/native/backend";
import { useDesignStore, type DesignIntent } from "@/stores/designStore";
import { DesignCanvasContext, type DesignCanvasActions } from "./design-canvas-context";
import { designController, resetDesignControllers } from "./design-controller";
import { resetCapabilities } from "./design-client";
import { DesignFrameView } from "./DesignFrameView";
import { DesignFrameBridge } from "./frame-bridge";

import { FakeBackend, canvasId, deferred, frameA, frameB, until } from "./design-test-backend";

let backend: FakeBackend;
const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const originalOrkestrator = window.orkestrator;
let listeners: Array<{ event: string; handler: (payload: unknown) => void }>;

function geometry(frameId: string, base: number, patch: Partial<DesignFrame>, gestureId: string) {
  return {
    descriptor: {
      input: { kind: "update_frame" as const, frameId, patch },
      preconditions: { frameRevision: base },
      gestureId,
    },
    label: `Edit ${frameId.slice(-1)}`,
    preview: { frameId, patch },
    gestureKey: `${gestureId}:update_frame`,
  };
}

describe("design canvas controller", () => {
  beforeEach(() => {
    backend = new FakeBackend();
    resetCapabilities();
    window.localStorage.clear();
    listeners = [];
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) =>
      backend.handle(command, args ?? {}),
    );
    window.orkestrator = {
      listen: (event: string, handler: (payload: unknown) => void) => {
        const entry = { event, handler };
        listeners.push(entry);
        return () => {
          listeners = listeners.filter((candidate) => candidate !== entry);
        };
      },
    } as unknown as Window["orkestrator"];
  });
  afterEach(() => {
    resetDesignControllers();
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve());
    window.orkestrator = originalOrkestrator;
  });

  test("repeated views share one projection and one hint listener", async () => {
    const first = designController("env-1", canvasId);
    const second = designController("env-1", canvasId);
    expect(first).toBe(second);
    const releaseA = first.acquire();
    const releaseB = second.acquire();
    await first.refresh();
    expect(listeners.filter((listener) => listener.event === "design-canvas-changed")).toHaveLength(
      1,
    );
    releaseA();
    releaseB();
    expect(listeners).toHaveLength(0);
  });

  test("a selector edit keeps its observed base: a structural change conflicts instead of retargeting", async () => {
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    const observed = controller.projection.workspace!.frames[frameA]!;
    // The agent replaces the frame after the user selected an element at revision 1.
    backend.externalReplace(frameA);
    await controller.refresh();
    controller.submit({
      descriptor: {
        input: {
          kind: "set_element_styles",
          frameId: frameA,
          selector: "body > :nth-child(1)",
          styles: { color: "red" },
        },
        preconditions: { frameRevision: 1, structureId: observed.structureId },
      },
      label: "Style p",
    });
    await until(() => controller.projection.intents[0]?.phase === "settled");
    const intent = controller.projection.intents[0]!;
    expect(intent.outcome).toBe("rejected");
    expect(intent.failure?.code).toBe("conflict");
    expect(backend.frames.get(frameA)!.frame.html).toBe("<p>agent</p>");
    // The draft is retained for Reselect/Discard.
    expect(intent.descriptor.input).toMatchObject({ styles: { color: "red" } });
    release();
  });

  test("move then resize of frame B while frame A is blocked: both intents survive", async () => {
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    const gate = deferred();
    backend.executeBarrier = async (descriptor) => {
      if ((descriptor.input as { frameId?: string }).frameId === frameA) await gate.promise;
    };
    controller.submit(geometry(frameA, 1, { x: 5 }, "g-a"));
    controller.submit(geometry(frameB, 1, { x: 100, y: 50 }, "g-move"));
    controller.submit(geometry(frameB, 1, { width: 900, height: 600 }, "g-resize"));
    await until(() => backend.frames.get(frameB)!.frame.revision === 3);
    gate.resolve();
    await until(() => controller.projection.intents.length === 0);
    expect(backend.frames.get(frameB)!.frame).toMatchObject({
      x: 100,
      y: 50,
      width: 900,
      height: 600,
      revision: 3,
    });
    expect(backend.frames.get(frameA)!.frame.x).toBe(5);
    release();
  });

  test("unsent samples of one gesture collapse to the newest", async () => {
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    const gate = deferred();
    let first = true;
    backend.executeBarrier = async () => {
      if (first) {
        first = false;
        await gate.promise;
      }
    };
    controller.submit(geometry(frameA, 1, { x: 1 }, "blocking"));
    controller.submit(geometry(frameA, 1, { x: 10 }, "keys"));
    controller.submit(geometry(frameA, 1, { x: 11 }, "keys"));
    controller.submit(geometry(frameA, 1, { x: 12 }, "keys"));
    expect(controller.projection.intents).toHaveLength(2);
    gate.resolve();
    await until(() => controller.projection.intents.length === 0);
    expect(
      backend.executions.map(
        (descriptor) => (descriptor.input as { patch: { x: number } }).patch.x,
      ),
    ).toEqual([1, 12]);
    expect(backend.frames.get(frameA)!.frame.x).toBe(12);
    release();
  });

  test("an agent edit between own edits breaks the proof chain and surfaces a conflict", async () => {
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    const gate = deferred();
    let first = true;
    backend.executeBarrier = async () => {
      if (first) {
        first = false;
        await gate.promise;
        backend.externalReplace(frameA); // another writer lands right after our first commit
      }
    };
    controller.submit(geometry(frameA, 1, { x: 1 }, "one"));
    controller.submit(geometry(frameA, 1, { y: 2 }, "two"));
    gate.resolve();
    await until(() =>
      controller.projection.intents.some(
        (intent) => intent.phase === "settled" && intent.outcome === "rejected",
      ),
    );
    const rejected = controller.projection.intents.find((intent) => intent.outcome === "rejected")!;
    expect(rejected.failure?.code).toBe("conflict");
    release();
  });

  test("a rejected edit pauses dependent edits in its lane; other frames continue", async () => {
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    const gate = deferred();
    backend.executeBarrier = async (descriptor) => {
      if ((descriptor.input as { frameId?: string }).frameId === frameA) await gate.promise;
    };
    controller.submit(geometry(frameA, 7, { x: 1 }, "stale")); // wrong base: rejected
    controller.submit(geometry(frameA, 1, { y: 9 }, "dependent"));
    controller.submit(geometry(frameB, 1, { x: 3 }, "independent"));
    await until(() => backend.frames.get(frameB)!.frame.x === 3);
    gate.resolve();
    await until(() => controller.projection.intents.some((intent) => intent.blocked));
    const dependent = controller.projection.intents.find(
      (intent) => intent.gestureKey === "dependent:update_frame",
    )!;
    expect(dependent.blocked).toBe(true);
    expect(backend.frames.get(frameA)!.frame.y).toBe(0);
    // Discarding the failed edit unblocks the lane.
    const failed = controller.projection.intents.find((intent) => intent.outcome === "rejected")!;
    await controller.discard(failed.id);
    await until(() => backend.frames.get(frameA)!.frame.y === 9);
    release();
  });

  test("a lost execute response after commit reconciles by status without a duplicate edit", async () => {
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    backend.executeBarrier = async () => {
      for (const token of backend.pending.keys()) backend.loseExecuteResponse.add(token);
    };
    controller.submit(geometry(frameA, 1, { x: 42 }, "lost"));
    await until(() => controller.projection.intents.length === 0, 5000);
    expect(backend.executions).toHaveLength(1);
    expect(backend.frames.get(frameA)!.frame).toMatchObject({ x: 42, revision: 2 });
    expect(backend.calls.filter((call) => call.command === "design_prepare")).toHaveLength(1);
    release();
  });

  test("a prepared draft restored after restart is never executed automatically", async () => {
    const key = `${window.location.origin}|env-1|${canvasId}`;
    const prepared = (await backend.handle("design_prepare", {
      descriptor: {
        canvasId,
        input: { kind: "update_frame", frameId: frameA, patch: { x: 9 } },
        preconditions: { frameRevision: 1 },
      },
    })) as { value: { token: string } };
    window.localStorage.setItem(
      "orkestrator.design.intents.v1",
      JSON.stringify({
        [key]: [
          {
            id: "i-restored",
            environmentId: "env-1",
            canvasId,
            lane: frameA,
            descriptor: {
              canvasId,
              input: { kind: "update_frame", frameId: frameA, patch: { x: 9 } },
              preconditions: { frameRevision: 1 },
            },
            label: "Move A",
            createdAt: 1,
            phase: "prepared",
            token: prepared.value.token,
          },
        ],
      }),
    );
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(backend.executions).toHaveLength(0);
    const intent = controller.projection.intents[0]!;
    expect(intent.restored).toBe(true);
    // An explicit Resume executes the same token once.
    controller.resume(intent.id);
    await until(() => backend.frames.get(frameA)!.frame.x === 9);
    expect(backend.executions).toHaveLength(1);
    release();
  });

  test("refresh awaiters resolve only after a cycle that started after the call", async () => {
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    const gate = deferred();
    const original = backend.handle.bind(backend);
    let blockSync = true;
    backend.handle = async (command, args) => {
      if (command === "design_sync" && blockSync) {
        blockSync = false;
        await gate.promise;
      }
      return original(command, args);
    };
    const first = controller.refresh();
    backend.externalReplace(frameB);
    const second = controller.refresh();
    let secondDone = false;
    void second.then(() => {
      secondDone = true;
    });
    gate.resolve();
    await first;
    await second;
    expect(secondDone).toBe(true);
    expect(controller.projection.revision).toBe(backend.revision);
    release();
  });

  test("a new generation replaces the projection even with a lower recovered revision", async () => {
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    backend.externalReplace(frameA);
    backend.externalReplace(frameA);
    await controller.refresh();
    expect(controller.projection.revision).toBe(3);
    backend.generation = "gen-2";
    backend.revision = 2;
    await controller.refresh();
    expect(controller.projection.generation).toBe("gen-2");
    expect(controller.projection.revision).toBe(2);
    release();
  });

  test("a v1 backend falls back to legacy snapshots, never an empty document", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "design_capabilities")
        throw new Error("Unknown backend command: design_capabilities");
      if (command === "design_changes")
        return { generation: "legacy", revision: 1, reset: true, events: [] };
      if (command === "design_action")
        return {
          canvas: backend.canvas(),
          history: { revision: 1, undoCount: 0, redoCount: 0, canUndo: false, canRedo: false },
        };
      throw new Error(`unexpected ${command}`);
    });
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    expect(controller.projection.legacy).toBe(true);
    expect(controller.projection.canvas?.frames).toHaveLength(2);
    release();
  });

  test("clean inactive projections are evicted; unsettled drafts are not", async () => {
    const controllers = Array.from({ length: 18 }, (_, index) =>
      designController(
        "env-1",
        `00000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`,
      ),
    );
    for (const controller of controllers) controller.acquire()();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useDesignStore.getState().projections.size).toBeLessThanOrEqual(16);
  });
});

describe("design canvas controller after a failure", () => {
  beforeEach(() => {
    backend = new FakeBackend();
    resetCapabilities();
    window.localStorage.clear();
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) =>
      backend.handle(command, args ?? {}),
    );
    window.orkestrator = { listen: () => () => {} } as unknown as Window["orkestrator"];
  });
  afterEach(() => {
    resetDesignControllers();
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve());
    window.orkestrator = originalOrkestrator;
  });

  test("an edit made after a visible failure is independent and runs", async () => {
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    controller.submit(geometry(frameA, 9, { x: 1 }, "stale"));
    await until(() =>
      controller.projection.intents.some((intent) => intent.outcome === "rejected"),
    );
    controller.submit(geometry(frameA, 1, { y: 4 }, "fresh"));
    await until(() => backend.frames.get(frameA)!.frame.y === 4);
    // The failure stays visible for review.
    expect(controller.projection.intents.some((intent) => intent.outcome === "rejected")).toBe(
      true,
    );
    release();
  });
});

const DRAFTS_KEY = "orkestrator.design.intents.v1";
const draftKey = `${window.location.origin}|env-1|${canvasId}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function seedRestored(intents: Array<Partial<DesignIntent> & { id: string; token?: string }>) {
  window.localStorage.setItem(
    DRAFTS_KEY,
    JSON.stringify({
      [draftKey]: intents.map((intent) => ({
        environmentId: "env-1",
        canvasId,
        lane: frameA,
        descriptor: {
          canvasId,
          input: { kind: "update_frame", frameId: frameA, patch: { x: 9 } },
          preconditions: { frameRevision: 1 },
        },
        label: "Move A",
        createdAt: 1,
        phase: "admitted",
        ...intent,
      })),
    }),
  );
}

function prepares() {
  return backend.calls.filter((call) => call.command === "design_prepare").length;
}

function byGesture(controller: ReturnType<typeof designController>, gestureId: string) {
  return controller.projection.intents.find(
    (intent) => intent.gestureKey === `${gestureId}:update_frame`,
  );
}

describe("design canvas controller regressions", () => {
  beforeEach(() => {
    backend = new FakeBackend();
    resetCapabilities();
    window.localStorage.clear();
    listeners = [];
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) =>
      backend.handle(command, args ?? {}),
    );
    window.orkestrator = {
      listen: (event: string, handler: (payload: unknown) => void) => {
        const entry = { event, handler };
        listeners.push(entry);
        return () => {
          listeners = listeners.filter((candidate) => candidate !== entry);
        };
      },
    } as unknown as Window["orkestrator"];
  });
  afterEach(() => {
    resetDesignControllers();
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve());
    window.orkestrator = originalOrkestrator;
  });

  test("a disconnected prepare waits for its backoff instead of re-running immediately", async () => {
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    let attempts = 0;
    let offline = true;
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "design_prepare") {
        attempts++;
        // Parks a runaway retry loop so a regression fails instead of hanging the run.
        if (attempts > 20) return new Promise(() => {});
        // A synchronously throwing transport must not spin the renderer either.
        if (offline) throw new Error("Failed to fetch");
      }
      return backend.handle(command, args ?? {});
    });
    controller.submit(geometry(frameA, 1, { x: 7 }, "offline"));
    await sleep(200);
    expect(attempts).toBe(1);
    expect(controller.projection.intents[0]!.phase).toBe("draft");
    offline = false;
    await until(() => backend.frames.get(frameA)!.frame.x === 7, 3000);
    expect(attempts).toBe(2);
    release();
  });

  test("a merged gesture sample keeps the gesture's original base and id", async () => {
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    const gate = deferred();
    backend.executeBarrier = async (descriptor) => {
      if ((descriptor.input as { frameId?: string }).frameId === frameB) await gate.promise;
    };
    // Occupies frame A's lane so the keyboard gesture stays unsent.
    controller.submit({ ...geometry(frameB, 1, { x: 1 }, "blocking"), lane: frameA });
    controller.submit(geometry(frameA, 1, { x: 10 }, "keys"));
    backend.externalReplace(frameA);
    await controller.refresh();
    // A later sample observed the other writer's revision.
    controller.submit(geometry(frameA, 2, { x: 11 }, "keys"));
    const merged = byGesture(controller, "keys")!;
    expect(merged.descriptor.preconditions).toEqual({ frameRevision: 1 });
    expect(merged.descriptor.gestureId).toBe("keys");
    expect(merged.descriptor.input).toMatchObject({ patch: { x: 11 } });
    gate.resolve();
    await until(() => byGesture(controller, "keys")?.phase === "settled");
    expect(byGesture(controller, "keys")!.failure?.code).toBe("conflict");
    expect(backend.frames.get(frameA)!.frame).toMatchObject({ html: "<p>agent</p>", x: 0 });
    release();
  });

  test("a prepared token that cannot be saved locally is held until an explicit Resume", async () => {
    // Other canvases already use the whole per-client draft budget.
    window.localStorage.setItem(
      DRAFTS_KEY,
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 4 }, (_, canvas) => [
            `other|env-1|${canvas}`,
            Array.from({ length: 8 }, (_, index) => ({
              id: `i-${canvas}-${index}`,
              lane: "canvas",
              descriptor: {},
            })),
          ]),
        ),
      ),
    );
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    controller.submit(geometry(frameA, 1, { x: 5 }, "held"));
    await until(() => controller.projection.intents[0]?.held === true);
    await sleep(50);
    const intent = controller.projection.intents[0]!;
    expect(intent.phase).toBe("prepared");
    expect(intent.token).toBeDefined();
    expect(backend.executions).toHaveLength(0);
    expect(controller.projection.notice?.tone).toBe("warning");
    controller.resume(intent.id);
    await until(() => backend.frames.get(frameA)!.frame.x === 5);
    expect(backend.executions).toHaveLength(1);
    expect(prepares()).toBe(1);
    release();
  });

  test("a restored in-flight token is reconciled, never re-prepared, and does not block new edits", async () => {
    const token = backend.prepareToken({
      input: { kind: "update_frame", frameId: frameA, patch: { x: 9 } },
      preconditions: { frameRevision: 1 },
    });
    backend.markExecuting(token);
    seedRestored([{ id: "i-restored", phase: "admitted", outcome: "unknown", token }]);
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    await until(() => controller.projection.intents[0]?.outcome === "executing");
    // A new edit in the same lane runs while the restored token is unresolved.
    controller.submit(geometry(frameA, 1, { y: 4 }, "new"));
    await until(() => backend.frames.get(frameA)!.frame.y === 4);
    // Resume keeps the token: an in-flight outcome is never prepared again.
    controller.resume("i-restored");
    const resumed = controller.projection.intents.find((intent) => intent.id === "i-restored")!;
    expect(resumed.token).toBe(token);
    expect(resumed.phase).toBe("admitted");
    backend.completePending(token);
    await until(
      () =>
        controller.projection.intents.find((intent) => intent.id === "i-restored")?.phase ===
        "settled",
      4000,
    );
    expect(prepares()).toBe(1);
    expect(backend.executions).toHaveLength(2);
    release();
  });

  test("resuming an unknown outcome keeps checking; a definitive not-run outcome re-prepares", async () => {
    const unknownToken = backend.prepareToken({
      input: { kind: "update_frame", frameId: frameA, patch: { x: 9 } },
      preconditions: { frameRevision: 1 },
    });
    backend.markExecuting(unknownToken);
    const rejectedToken = backend.prepareToken({
      input: { kind: "update_frame", frameId: frameB, patch: { x: 6 } },
      preconditions: { frameRevision: 1 },
    });
    backend.setReceipt(rejectedToken, "rejected");
    const failure: DesignFailure = { code: "unknown-outcome", message: "unknown", retry: "review" };
    seedRestored([
      { id: "i-unknown", phase: "settled", outcome: "unknown", failure, token: unknownToken },
      {
        id: "i-rejected",
        lane: frameB,
        phase: "settled",
        outcome: "rejected",
        failure: { ...failure, code: "capacity" },
        token: rejectedToken,
        descriptor: {
          canvasId,
          input: { kind: "update_frame", frameId: frameB, patch: { x: 6 } },
          preconditions: { frameRevision: 1 },
        },
      },
    ]);
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    controller.resume("i-unknown");
    expect(controller.projection.intents.find((intent) => intent.id === "i-unknown")?.token).toBe(
      unknownToken,
    );
    controller.resume("i-rejected");
    await until(() => backend.frames.get(frameB)!.frame.x === 6);
    expect(prepares()).toBe(1);
    backend.completePending(unknownToken);
    await until(() => backend.frames.get(frameA)!.frame.x === 9);
    await until(() => controller.projection.intents.length === 0, 4000);
    expect(prepares()).toBe(1);
    release();
  });

  test("releasing one view defers eviction so the next view can acquire its controller", async () => {
    const id = (index: number) =>
      `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`;
    const next = designController("env-1", id(0));
    const others = Array.from({ length: 17 }, (_, index) =>
      designController("env-1", id(index + 1)),
    );
    next.lastUsed = 0;
    // One commit: A's effect cleanup runs before B's effect acquires.
    const releaseA = others[0]!.acquire();
    releaseA();
    const releaseB = next.acquire();
    await sleep(0);
    expect(next.isDisposed).toBe(false);
    expect(next.visible).toBe(true);
    expect(designController("env-1", id(0))).toBe(next);
    releaseB();
  });

  test("an evicted controller is inert and is replaced by a live one", () => {
    const evicted = designController("env-1", canvasId);
    evicted.dispose();
    expect(() => evicted.acquire()()).not.toThrow();
    expect(evicted.visible).toBe(false);
    expect(listeners).toHaveLength(0);
    const replacement = designController("env-1", canvasId);
    expect(replacement).not.toBe(evicted);
    expect(replacement.isDisposed).toBe(false);
  });

  test("discarding one failure unblocks only edits with no other failure ahead", async () => {
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    const gate = deferred();
    let first = true;
    backend.executeBarrier = async () => {
      if (first) {
        first = false;
        await gate.promise;
      }
    };
    controller.submit(geometry(frameA, 7, { x: 1 }, "f1"));
    controller.submit(geometry(frameA, 8, { x: 2 }, "f2"));
    controller.submit(geometry(frameA, 1, { y: 9 }, "dep"));
    gate.resolve();
    await until(() => byGesture(controller, "f1")?.outcome === "rejected");
    expect(byGesture(controller, "dep")!.blocked).toBe(true);
    controller.resume(byGesture(controller, "f2")!.id);
    await until(() => byGesture(controller, "f2")?.outcome === "rejected");
    await controller.discard(byGesture(controller, "f2")!.id);
    await sleep(50);
    // f1 is still unreviewed ahead of it.
    expect(byGesture(controller, "dep")!.blocked).toBe(true);
    expect(backend.frames.get(frameA)!.frame.y).toBe(0);
    await controller.discard(byGesture(controller, "f1")!.id);
    await until(() => backend.frames.get(frameA)!.frame.y === 9);
    release();
  });

  test("own-commit proofs are forgotten when their frame is removed", async () => {
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    controller.submit(geometry(frameA, 1, { x: 3 }, "own"));
    await until(() => controller.projection.intents.length === 0);
    backend.removeFrame(frameA);
    await controller.refresh();
    backend.addFrame(frameA);
    await controller.refresh();
    controller.submit(geometry(frameA, 1, { x: 4 }, "after"));
    await until(
      () =>
        byGesture(controller, "after")?.phase !== "draft" &&
        !controller.projection.intents.some((intent) => intent.phase !== "settled"),
    );
    expect(byGesture(controller, "after")?.outcome).not.toBe("rejected");
    expect(backend.frames.get(frameA)!.frame.x).toBe(4);
    release();
  });

  test("own-commit proofs are forgotten when a frame is recreated between syncs", async () => {
    const controller = designController("env-1", canvasId);
    const release = controller.acquire();
    await controller.refresh();
    controller.submit(geometry(frameA, 1, { x: 3 }, "own"));
    await until(() => controller.projection.intents.length === 0);
    backend.removeFrame(frameA);
    backend.addFrame(frameA);
    await controller.refresh();
    controller.submit(geometry(frameA, 1, { x: 4 }, "after"));
    await until(() => backend.frames.get(frameA)!.frame.x === 4);
    release();
  });
});

describe("element resize gesture", () => {
  afterEach(() => {
    cleanup();
    mock.restore();
  });

  test("Escape and lost pointer capture cancel the drag, unpin, and keep the selection", async () => {
    spyOn(DesignFrameBridge.prototype, "ask").mockResolvedValue(undefined as never);
    const pin = mock((_frameId: string, _pinned: boolean) => undefined);
    const submitElementResize = mock(() => undefined);
    const actions = {
      pin,
      submitElementResize,
      registerBridge: () => undefined,
      frameRendered: () => undefined,
      reportError: () => undefined,
      exitPreview: () => undefined,
      frameAction: () => undefined,
      focusFrame: () => undefined,
      select: () => undefined,
      submitGeometry: () => undefined,
    } as unknown as DesignCanvasActions;
    const frame: DesignFrame = {
      id: frameA,
      name: "A",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      html: "<p>x</p>",
      revision: 1,
    };
    const selected = {
      frameId: frameA,
      revision: 1,
      element: {
        selector: "p",
        tag: "p",
        text: "x",
        attributes: {},
        styles: {},
        rect: { x: 10, y: 10, width: 100, height: 40 },
      },
    };
    render(
      createElement(
        DesignCanvasContext.Provider,
        { value: actions },
        createElement(DesignFrameView, {
          frame,
          committed: frame,
          live: true,
          zoom: 1,
          mode: "inspect",
          selected,
          pending: false,
          canRestorePrevious: false,
          focused: true,
        }),
      ),
    );
    await act(async () => {
      fireEvent.load(screen.getByTitle("A"));
      await sleep(0);
    });
    const handle = await screen.findByLabelText("Resize selected element");
    handle.setPointerCapture = () => undefined;
    const windowEscape = mock((event: KeyboardEvent) => event.defaultPrevented);
    window.addEventListener("keydown", windowEscape);
    try {
      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
      expect(pin).toHaveBeenLastCalledWith(frameA, true);
      fireEvent.keyDown(handle, { key: "Escape" });
      expect(windowEscape.mock.results[0]?.value).toBe(true);
      expect(pin).toHaveBeenLastCalledWith(frameA, false);

      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 30, clientY: 30 });
      fireEvent(handle, new Event("lostpointercapture", { bubbles: true }));
      expect(pin).toHaveBeenLastCalledWith(frameA, false);
      fireEvent.pointerUp(handle, { pointerId: 1 });
      expect(submitElementResize).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", windowEscape);
    }
  });
});
