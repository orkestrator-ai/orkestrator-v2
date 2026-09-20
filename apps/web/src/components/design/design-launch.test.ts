import { describe, expect, mock, test } from "bun:test";
import type { DesignCanvas } from "@orkestrator/protocol/design-canvas";
import { importAndOpenDesign, launchDesignWorkspace } from "./design-launch";

const canvas = {
  format: "orkdes",
  version: 1,
  id: "64d58108-a2a1-46d8-a8ae-459d98fb6e06",
  environmentId: "env",
  name: "Design",
  revision: 1,
  frames: [],
} satisfies DesignCanvas;

describe("design workspace launch transaction", () => {
  test("opens the agent and adjacent canvas only after durable creation", async () => {
    const calls: string[] = [];
    const result = await launchDesignWorkspace({
      name: "Design",
      agent: "codex",
      prompt: "Build it",
      agentTabId: "agent-tab",
      action: async (action) => {
        calls.push(action);
        return canvas as never;
      },
      createTab: (type, options) => {
        calls.push(`${type}:${options?.tabId}`);
        expect(options?.initialPrompt).toContain(canvas.id);
        return true;
      },
      openCanvas: (id) => calls.push(`canvas:${id}`),
      removeAgentTab: () => calls.push("remove-agent"),
    });
    expect(result).toBe(canvas);
    expect(calls).toEqual(["create_canvas", "codex:agent-tab", `canvas:${canvas.id}`]);
  });

  test("rolls back the agent tab and canvas when the split fails", async () => {
    const removed = mock(() => {});
    const action = mock(async (name: string) => (name === "create_canvas" ? canvas : undefined));
    await expect(
      launchDesignWorkspace({
        name: "Design",
        agent: "claude",
        prompt: "",
        agentTabId: "agent-tab",
        action: action as never,
        createTab: () => true,
        openCanvas: () => {
          throw new Error("maximum split depth");
        },
        removeAgentTab: removed,
      }),
    ).rejects.toThrow("maximum split depth");
    expect(removed).toHaveBeenCalledWith("agent-tab");
    expect(action.mock.calls.map((call) => call[0])).toEqual(["create_canvas", "delete_canvas"]);
  });

  test("deletes an imported canvas when it cannot be opened", async () => {
    const remove = mock(async () => undefined);
    await expect(
      importAndOpenDesign({
        document: "{}",
        importCanvas: async () => canvas,
        openCanvas: () => {
          throw new Error("no split");
        },
        deleteCanvas: remove,
      }),
    ).rejects.toThrow("no split");
    expect(remove).toHaveBeenCalledWith(canvas.id);
  });
});
