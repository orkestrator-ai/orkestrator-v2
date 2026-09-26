import { describe, expect, mock, test } from "bun:test";
import type { DesignCanvas } from "@orkestrator/protocol/design-canvas";
import type {
  DesignCapabilities,
  DesignOperationStatus,
  DesignReadiness,
} from "@orkestrator/protocol/design-operations";
import { DesignClientError } from "./design-client";
import {
  buildDesignAgentPrompt,
  DesignLaunchError,
  importAndOpenDesign,
  launchDesignWorkspace,
  legacyLibraryPage,
  loadDesignReadiness,
  readDesignImport,
  runDesignLifecycle,
  validateDesignName,
  type DesignLaunchOptions,
} from "./design-launch";

const canvas = {
  format: "orkdes",
  version: 1,
  id: "64d58108-a2a1-46d8-a8ae-459d98fb6e06",
  environmentId: "env",
  name: "Design",
  revision: 1,
  frames: [],
} satisfies DesignCanvas;

function harness(overrides: Partial<DesignLaunchOptions> = {}) {
  const calls: string[] = [];
  const tabs = new Set<string>();
  const options: DesignLaunchOptions = {
    name: "  Design  ",
    agent: "codex",
    brief: "Build it",
    framePreset: "none",
    placement: "split",
    canvasTabId: "canvas-tab",
    agentTabId: "agent-tab",
    createCanvas: mock(async (name: string) => {
      calls.push(`create:${name}`);
      return canvas;
    }),
    createFrame: mock(async () => {
      calls.push("frame");
      return { canvasRevision: 2 };
    }),
    openCanvas: mock((canvasId: string, tabId: string, placement: string) => {
      calls.push(`open:${canvasId}:${tabId}:${placement}`);
      tabs.add(tabId);
      return true;
    }),
    createAgentTab: mock((agent: string, tabId: string, prompt: string) => {
      calls.push(`agent:${agent}:${tabId}`);
      expect(prompt).toContain(canvas.id);
      tabs.add(tabId);
      return true;
    }),
    hasTab: (tabId) => tabs.has(tabId),
    removeTab: mock((tabId: string) => {
      calls.push(`remove:${tabId}`);
      tabs.delete(tabId);
    }),
    deleteCanvas: mock(async (canvasId: string, revision: number) => {
      calls.push(`delete:${canvasId}@${revision}`);
    }),
    linkSession: mock(async (canvasId: string, tabId: string, platform: string) => {
      calls.push(`link:${canvasId}:${tabId}:${platform}`);
    }),
    ...overrides,
  };
  return { calls, tabs, options };
}

describe("design workspace launch transaction", () => {
  test("creates the document, opens the canvas, then the agent, then links the session", async () => {
    const { calls, options } = harness();
    const stages: string[] = [];
    const result = await launchDesignWorkspace({
      ...options,
      onStage: (stage) => stages.push(stage),
    });
    expect(result).toEqual({ canvas });
    expect(calls).toEqual([
      "create:Design",
      `open:${canvas.id}:canvas-tab:split`,
      "agent:codex:agent-tab",
      `link:${canvas.id}:agent-tab:codex`,
    ]);
    expect(stages).toEqual([
      "create-document",
      "allocate-layout",
      "create-agent",
      "link-session",
      "done",
    ]);
  });

  test("a blank canvas creates no agent tab and no session link", async () => {
    const { calls, options } = harness({ agent: null, placement: "current" });
    await launchDesignWorkspace(options);
    expect(calls).toEqual(["create:Design", `open:${canvas.id}:canvas-tab:current`]);
  });

  test("an initial frame preset is created before the layout is allocated", async () => {
    const { calls, options } = harness({ framePreset: "mobile", agent: null });
    await launchDesignWorkspace(options);
    expect(calls.slice(0, 2)).toEqual(["create:Design", "frame"]);
    const frame = (options.createFrame as ReturnType<typeof mock>).mock.calls[0]?.[1];
    expect(frame).toMatchObject({ width: 390, height: 844 });
  });

  test("layout failure before the agent exists rolls back the canvas at its latest revision", async () => {
    const { calls, options } = harness({
      framePreset: "desktop",
      openCanvas: () => false,
    });
    const error = await launchDesignWorkspace(options).catch((reason) => reason);
    expect(error).toBeInstanceOf(DesignLaunchError);
    expect(error.stage).toBe("allocate-layout");
    expect(error.recoverable).toBe(false);
    expect(error.canvas).toBeNull();
    expect(calls).toEqual(["create:Design", "frame", `delete:${canvas.id}@2`]);
  });

  test("agent tab failure removes the canvas tab this attempt created and the canvas", async () => {
    const { calls, tabs, options } = harness({ createAgentTab: () => false });
    const error = await launchDesignWorkspace(options).catch((reason) => reason);
    expect(error.stage).toBe("create-agent");
    expect(error.recoverable).toBe(false);
    expect(calls).toEqual([
      "create:Design",
      `open:${canvas.id}:canvas-tab:split`,
      "remove:canvas-tab",
      `delete:${canvas.id}@1`,
    ]);
    expect(tabs.size).toBe(0);
  });

  test("a failed rollback reports that the design remains", async () => {
    const { options } = harness({
      openCanvas: () => false,
      deleteCanvas: async () => {
        throw new Error("offline");
      },
    });
    const error = await launchDesignWorkspace(options).catch((reason) => reason);
    expect(error.message).toContain("remains in Open");
    expect(error.canvas).toBe(canvas);
    expect(error.recoverable).toBe(false);
  });

  test("failure after the agent tab exists keeps the canvas and is recoverable", async () => {
    const { calls, tabs, options } = harness({
      createAgentTab: (_agent, tabId) => {
        tabs.add(tabId);
        throw new Error("mount failed");
      },
    });
    const error = await launchDesignWorkspace(options).catch((reason) => reason);
    expect(error).toBeInstanceOf(DesignLaunchError);
    expect(error.recoverable).toBe(true);
    expect(error.canvas).toBe(canvas);
    expect(error.message).toContain("Your design was created");
    expect(calls.some((call) => call.startsWith("delete:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("remove:"))).toBe(false);
  });

  test("a failed session link is best effort", async () => {
    const { options } = harness({
      linkSession: async () => {
        throw new Error("links full");
      },
    });
    const result = await launchDesignWorkspace(options);
    expect(result.canvas).toBe(canvas);
    expect(result.linkWarning).toContain("links full");
  });

  test("document creation failure creates nothing to roll back", async () => {
    const { calls, options } = harness({
      createCanvas: async () => {
        throw new Error("Canvas limit reached");
      },
    });
    const error = await launchDesignWorkspace(options).catch((reason) => reason);
    expect(error.stage).toBe("create-document");
    expect(calls).toEqual([]);
  });
});

describe("design inputs", () => {
  test("validates trimmed, non-blank names of at most 120 characters", () => {
    expect(validateDesignName("   ")).toContain("Enter a name");
    expect(validateDesignName("x".repeat(121))).toContain("120");
    expect(validateDesignName(`  ${"x".repeat(120)}  `)).toBeNull();
  });

  test("the agent prompt recommends compact, conflict-safe tools and save_canvas", () => {
    const prompt = buildDesignAgentPrompt("canvas-1", "  ");
    for (const expected of [
      "Canvas ID: canvas-1",
      "get_canvas_summary",
      "get_frame",
      'response:"compact"',
      "re-read the frame",
      "capture_frame",
      "save_canvas",
      "replaceFingerprint",
      "propose an initial design mockup",
    ])
      expect(prompt).toContain(expected);
  });
});

describe("design import", () => {
  const file = (name: string, text: string, type = "application/json", size = text.length) => ({
    name,
    type,
    size,
    text: async () => text,
  });
  const valid = JSON.stringify({ format: "orkdes", version: 1 });

  test("accepts a version-1 .orkdes document", async () => {
    expect(await readDesignImport(file("a.orkdes", valid, ""))).toBe(valid);
  });

  test("rejects wrong type, oversize, malformed, foreign and future files", async () => {
    await expect(readDesignImport(file("a.png", valid, "image/png"))).rejects.toThrow(".orkdes");
    await expect(
      readDesignImport(file("a.orkdes", valid, "", 4 * 1024 * 1024 + 1)),
    ).rejects.toThrow("4 MiB");
    await expect(readDesignImport(file("a.orkdes", "{"))).rejects.toThrow("not a valid");
    await expect(readDesignImport(file("a.json", "{}"))).rejects.toThrow("not an .orkdes");
    await expect(
      readDesignImport(file("a.orkdes", JSON.stringify({ format: "orkdes", version: 2 }))),
    ).rejects.toThrow("version 2 is not supported");
  });

  test("keeps an import that cannot be opened yet", async () => {
    const result = await importAndOpenDesign({
      document: "{}",
      importCanvas: async () => canvas,
      openCanvas: () => "No room",
    });
    expect(result).toEqual({ canvas, opened: false, openError: "No room" });
  });
});

const capabilities = { protocolVersion: 2, sessions: true, lifecycle: true } as DesignCapabilities;

describe("loadDesignReadiness", () => {
  test("maps v2 readiness into separate backend, storage and renderer facts", async () => {
    const readiness = mock(async (): Promise<DesignReadiness> => ({
      capabilities,
      storage: { available: true, canvases: 3, limit: 256 },
      renderer: {
        state: "missing-executable",
        ready: false,
        message: "install",
        queued: 0,
        running: 0,
        generation: 0,
        executableConfigured: false,
      },
    }));
    const view = await loadDesignReadiness(true, {
      capabilities: async () => capabilities,
      readiness,
      legacyStatus: async () => ({ ready: true }),
    });
    expect(readiness).toHaveBeenCalledWith(true);
    expect(view.protocol).toBe("v2");
    expect(view.backend.state).toBe("connected");
    expect(view.storage).toEqual({ state: "available", canvases: 3, limit: 256 });
    expect(view.renderer.state).toBe("missing-executable");
  });

  test("falls back to design_status on an old backend", async () => {
    const view = await loadDesignReadiness(true, {
      capabilities: async () => null,
      readiness: async () => {
        throw new Error("must not be called");
      },
      legacyStatus: async () => ({
        ready: false,
        error:
          "Design workspaces require Chromium. Install Chromium or set ORKESTRATOR_DESIGN_CHROMIUM_PATH.",
      }),
    });
    expect(view.protocol).toBe("v1");
    expect(view.capabilities).toBeNull();
    expect(view.renderer.state).toBe("missing-executable");
  });

  test("reports a disconnected backend without guessing renderer state", async () => {
    const view = await loadDesignReadiness(true, {
      capabilities: async () => {
        throw new Error("Failed to fetch");
      },
      readiness: async () => {
        throw new Error("unreachable");
      },
      legacyStatus: async () => ({ ready: true }),
    });
    expect(view.backend.state).toBe("disconnected");
    expect(view.renderer.state).toBe("unknown");
  });

  test("a storage failure is distinct from a disconnected backend", async () => {
    const view = await loadDesignReadiness(false, {
      capabilities: async () => capabilities,
      readiness: async () => {
        throw new DesignClientError({ code: "storage", message: "disk full", retry: "never" });
      },
      legacyStatus: async () => ({ ready: true }),
    });
    expect(view.backend.state).toBe("connected");
    expect(view.storage).toEqual({ state: "unavailable", message: "disk full" });
  });
});

describe("library helpers", () => {
  test("legacy pages search and paginate a name-only list", async () => {
    const list = async () =>
      Array.from({ length: 60 }, (_, index) => ({ id: `c${index}`, name: `Design ${index}` }));
    const first = await legacyLibraryPage("env", { limit: 50 }, list);
    expect(first.entries).toHaveLength(50);
    expect(first.nextOffset).toBe(50);
    expect(first.entries[0]?.legacy).toBe(true);
    const search = await legacyLibraryPage("env", { search: "design 5", limit: 50 }, list);
    expect(search.entries.map((entry) => entry.id)).toEqual([
      "c5",
      ...Array.from({ length: 10 }, (_, index) => `c${50 + index}`),
    ]);
    expect((await legacyLibraryPage("env", { filter: "deleted" }, list)).entries).toEqual([]);
  });

  test("lifecycle operations resolve only when committed", async () => {
    const status = (state: DesignOperationStatus["state"], extra = {}) =>
      ({
        token: "t",
        canvasId: "c",
        kind: "rename_canvas",
        state,
        ...extra,
      }) as DesignOperationStatus;
    const prepare = mock(async (_environmentId: string, _descriptor: unknown) => ({
      token: "t",
      canvasId: "c",
      state: "prepared" as const,
      expiresAt: "",
    }));
    let next = status("committed");
    const execute = mock(async () => next);
    const api = { prepare, execute } as never;
    await expect(
      runDesignLifecycle(
        "env",
        "c",
        { kind: "rename_canvas", name: "B" },
        { canvasRevision: 3 },
        api,
      ),
    ).resolves.toBe(next);
    expect(prepare.mock.calls[0]?.[1]).toMatchObject({
      canvasId: "c",
      input: { kind: "rename_canvas", name: "B" },
      preconditions: { canvasRevision: 3 },
    });
    next = status("rejected", {
      failure: { code: "conflict", message: "changed", retry: "after-refresh" },
    });
    const rejected = await runDesignLifecycle("env", "c", { kind: "delete_canvas" }, {}, api).catch(
      (reason) => reason,
    );
    expect(rejected).toBeInstanceOf(DesignClientError);
    expect(rejected.failure.code).toBe("conflict");
    next = status("executing");
    const pending = await runDesignLifecycle("env", "c", { kind: "delete_canvas" }, {}, api).catch(
      (reason) => reason,
    );
    expect(pending.failure.code).toBe("unknown-outcome");
  });
});
