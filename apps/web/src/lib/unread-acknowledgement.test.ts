import { describe, expect, test } from "bun:test";
import type { EnvironmentPaneState } from "@/stores/paneLayoutStore";
import type { TabInfo } from "@/types/paneLayout";
import { unreadAcknowledgement } from "./unread-acknowledgement";

const key = (tabId: string) => `env-env-1:${tabId}`;

function tab(id: string, extra: Partial<TabInfo> = {}): TabInfo {
  return { id, type: "agent-native", ...extra } as TabInfo;
}

function layout(
  leaves: Array<{ tabs: TabInfo[]; activeTabId: string | null }>,
): EnvironmentPaneState {
  const [first, second] = leaves.map((leaf, index) => ({
    kind: "leaf" as const,
    id: `pane-${index}`,
    ...leaf,
  }));
  return {
    root: second
      ? { kind: "split", id: "split", direction: "horizontal", children: [first!, second] }
      : first!,
    activePaneId: "pane-0",
    containerId: null,
  } as EnvironmentPaneState;
}

describe("unreadAcknowledgement", () => {
  test("a badge without attributed sessions belongs to the environment", () => {
    expect(unreadAcknowledgement({ id: "env-1" }, undefined, undefined)).toEqual({
      kind: "environment",
    });
    expect(
      unreadAcknowledgement({ id: "env-1", unreadSessionKeys: [] }, undefined, "done"),
    ).toEqual({ kind: "environment" });
  });

  test("waits for the environment's tabs before deciding", () => {
    const environment = { id: "env-1", unreadSessionKeys: [key("a")] };
    expect(unreadAcknowledgement(environment, undefined, undefined).kind).toBe("pending");
    const known = layout([{ tabs: [tab("a")], activeTabId: "a" }]);
    expect(unreadAcknowledgement(environment, known, "pending").kind).toBe("pending");
  });

  test("only the selected tab of a pane acknowledges its session", () => {
    const environment = { id: "env-1", unreadSessionKeys: [key("a")] };
    const otherSelected = layout([{ tabs: [tab("a"), tab("b")], activeTabId: "b" }]);
    expect(unreadAcknowledgement(environment, otherSelected, "done")).toEqual({ kind: "none" });
    const selected = layout([{ tabs: [tab("a"), tab("b")], activeTabId: "a" }]);
    expect(unreadAcknowledgement(environment, selected, "done")).toEqual({
      kind: "sessions",
      sessionKeys: [key("a")],
      remaining: [],
    });
  });

  test("every split pane's selected tab is on screen; unseen sessions remain", () => {
    const environment = { id: "env-1", unreadSessionKeys: [key("a"), key("c"), key("d")] };
    const split = layout([
      { tabs: [tab("a"), tab("b")], activeTabId: "a" },
      { tabs: [tab("c"), tab("d")], activeTabId: "c" },
    ]);
    expect(unreadAcknowledgement(environment, split, "done")).toEqual({
      kind: "sessions",
      sessionKeys: [key("a"), key("c")],
      remaining: [key("d")],
    });
  });

  test("a session no tab can show is acknowledged by seeing the environment", () => {
    const environment = { id: "env-1", unreadSessionKeys: [key("closed"), key("a")] };
    const known = layout([{ tabs: [tab("a"), tab("b")], activeTabId: "b" }]);
    expect(unreadAcknowledgement(environment, known, "done")).toEqual({
      kind: "sessions",
      sessionKeys: [key("closed")],
      remaining: [key("a")],
    });
  });

  test("an agent embedded in a shown design canvas is on screen unless its panel is closed", () => {
    const environment = { id: "env-1", unreadSessionKeys: [key("agent")] };
    const open = layout([
      {
        tabs: [
          tab("canvas", { type: "design-canvas" } as Partial<TabInfo>),
          tab("agent", { embeddedIn: "canvas" }),
        ],
        activeTabId: "canvas",
      },
    ]);
    expect(unreadAcknowledgement(environment, open, "done").kind).toBe("sessions");
    const closed = layout([
      {
        tabs: [
          tab("canvas", {
            type: "design-canvas",
            designCanvasData: { canvasId: "c", agentPanel: { dock: "left", open: false } },
          } as Partial<TabInfo>),
          tab("agent", { embeddedIn: "canvas" }),
        ],
        activeTabId: "canvas",
      },
    ]);
    expect(unreadAcknowledgement(environment, closed, "done")).toEqual({ kind: "none" });
  });
});
